/**
 * Cayden's morning grid. Reads the hourly campaign-check records, the
 * stored generic-pool findings, the last placement snapshot, and open
 * isolation suspects. It does not call Smartlead.
 */

import { isAnyShellCampaign } from "../lib/canaryShell.js";
import {
  campaignCheckIsActive,
  type CampaignCheckRecord,
} from "../lib/campaignCheck.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import { matchClientForCampaign } from "../lib/campaignClient.js";
import { findingKind } from "../lib/canonCompliance.js";
import {
  SEND_WINDOW_END_HOUR,
  SEND_WINDOW_START_HOUR,
} from "../lib/campaignSendCanon.js";
import { clientDisplayName, type SmartleadClientRecord } from "../clients/smartlead.js";
import { callingClientKey } from "./callingBoard.js";
import { OPS_ALERTS_LABEL, OPS_ISOLATION_HINT } from "./canonSurface.js";

export interface TodayFailure {
  id: string;
  text: string;
  actionId: "refresh-placement" | "open-fix";
  actionLabel: string;
}

export interface TodayCell {
  ok: boolean;
  /** No calling or LinkedIn lane for this client. Not a pass and not a fail. */
  idle?: boolean;
  /** Placement tests still running (no score yet). Grey, not a fail. */
  pending?: number;
  /** Informational findings (e.g. idle generics). Not a fail. */
  info?: number;
  failures: TodayFailure[];
}

export interface TodayColumn {
  id: TodayColumnId;
  label: string;
  hint: string;
}

export type TodayColumnId =
  | "pods"
  | "generics"
  | "senders"
  | "settings"
  | "sequence"
  | "signatures"
  | "placement"
  | "copy"
  | "isolation"
  | "calling"
  | "linkedin";

export interface TodayClientRow {
  clientId: string;
  clientName: string;
  cells: Record<TodayColumnId, TodayCell>;
}

export interface TodayBoard {
  lastSweepAt: string | null;
  nextSweepAt: string;
  hourlySweep: "on" | "off";
  canonCheck: string;
  alertsLabel: string;
  checksPassing: number;
  checksFailing: number;
  clientsAllGreen: number;
  clientsTotal: number;
  columns: TodayColumn[];
  rows: TodayClientRow[];
  restRollover: {
    daysUntil: number;
    nextRolloverYmd: string;
    onWeekCohort: "A" | "B";
    offWeekCohort: "A" | "B";
  };
}

export interface TodayCampaignRef {
  id: number;
  name: string;
  status?: string | null;
  client_id?: number | null;
}

export interface TodayPlacementRow {
  id: string;
  campaignId?: number;
  campaignName?: string;
  status?: string;
  googleInboxPercent?: number;
  microsoftInboxPercent?: number;
}

export interface TodayIsolationHit {
  campaignId: number;
  campaignName?: string;
  text: string;
}

export interface TodayLaneHit {
  clientName: string;
  ok: boolean;
  failures: Array<{ id: string; text: string }>;
}

interface ClientBucket {
  clientId: string;
  clientName: string;
  failures: Map<TodayColumnId, TodayFailure[]>;
  pending: Map<TodayColumnId, number>;
  info: Map<TodayColumnId, number>;
}

/**
 * Findings shown as information, never a red: an idle generic is spare
 * capacity in the pool, not a broken client.
 */
export const TODAY_INFO_KINDS: ReadonlySet<string> = new Set(["generic_idle"]);

/** A placement snapshot older than this is not shown on Today at all. */
export const TODAY_PLACEMENT_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const COLUMN_KINDS: Record<TodayColumnId, readonly string[]> = {
  pods: ["understaffed"],
  generics: [
    "generic_idle",
    "generic_multi_client",
    "generic_outside_table",
    "generic_outside_ledger",
    "generic_not_warming",
    "generic_on_insight",
    "pod_short_no_free_generic",
  ],
  senders: [
    "under_warmed",
    "cross_client_membership",
    "esp_mix",
    "insight_non_josh_sender",
    "insight_shared_staff",
  ],
  settings: [
    "esp_matching_off",
    "mailbox_gap",
    "campaign_min_gap",
    "campaign_send_gap",
    "send_window",
  ],
  // D186 step-2 delay and a failed sequence read. D327: exactly 2
  // messages, so a missing step 3 is not a finding. These are not
  // campaign settings.
  sequence: ["step2_delay", "unverified"],
  signatures: [
    "mailbox_sig",
    "missing_signature_tag",
    "foreign_brand_in_copy",
  ],
  placement: [
    "no_placement_test",
    "missing_canary",
    "canary_inactive",
    "inbox_missing_known_good",
    "below_launch_bar",
    "placement_unknown",
  ],
  copy: ["merge_tag_blank"],
  isolation: ["isolation_open"],
  calling: [],
  linkedin: [],
};

function sameClient(left: string, right: string): boolean {
  const a = callingClientKey(left);
  const b = callingClientKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 5 && longer.startsWith(shorter);
}

function hourClock(hhmm: string): string {
  const hour = Number(hhmm.slice(0, 2));
  if (!Number.isFinite(hour)) return hhmm;
  const suffix = hour >= 12 ? "p" : "a";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${suffix}`;
}

export function campaignSettingsHint(): string {
  const start = hourClock(SEND_WINDOW_START_HOUR);
  const end = hourClock(SEND_WINDOW_END_HOUR);
  return `ESP match · 10m gap · Mon–Thu ${start}–${end} ET`;
}

export function todayColumns(): TodayColumn[] {
  return [
    { id: "pods", label: "Pods", hint: "40+ · A/B within 15% · this week linked" },
    {
      id: "generics",
      label: "Generics",
      hint: "fill to 40 · one client · ledger · never Insight",
    },
    { id: "senders", label: "Senders", hint: "14d warmup · one client · ESP mix" },
    { id: "settings", label: "Campaign settings", hint: campaignSettingsHint() },
    {
      id: "sequence",
      label: "Sequence",
      hint: "exactly 2 messages · step 2 at 2d",
    },
    {
      id: "signatures",
      label: "Signatures",
      hint: "correct · no doubles · none in copy except cold-call",
    },
    {
      id: "placement",
      label: "Placement",
      hint: "spam test · known-good · canary",
    },
    {
      id: "copy",
      label: "Copy",
      hint: "merge tags · spintax · QA · NBA only",
    },
    { id: "isolation", label: "Isolation", hint: OPS_ISOLATION_HINT },
    {
      id: "calling",
      label: "Calling",
      hint: "queue 300 · voicemail match · router",
    },
    {
      id: "linkedin",
      label: "LinkedIn",
      hint: "30–35 connects · replies counted",
    },
  ];
}

function columnForKind(kind: string): TodayColumnId | null {
  for (const [id, kinds] of Object.entries(COLUMN_KINDS) as Array<
    [TodayColumnId, readonly string[]]
  >) {
    if (kinds.includes(kind)) return id;
  }
  return null;
}

function actionFor(kind: string): Pick<TodayFailure, "actionId" | "actionLabel"> {
  if (kind === "no_placement_test" || kind === "placement_unknown") {
    return { actionId: "refresh-placement", actionLabel: "Refresh placement" };
  }
  return { actionId: "open-fix", actionLabel: "Open in Fix queue" };
}

/** Next fire of `0 * * * *` in the process timezone (the hourly sweep cron). */
export function nextHourlySweep(now: Date): Date {
  const next = new Date(now.getTime());
  next.setMinutes(0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setHours(next.getHours() + 1);
  }
  return next;
}

export function canonCheckLabel(cronHealth: string): string {
  return cronHealth.trim() === "*/15 * * * *" ? "every 15 min" : cronHealth;
}

function clientNameOf(
  client: SmartleadClientRecord | undefined,
  fallback: string,
): string {
  if (!client) return fallback;
  const brand = brandFromClientDisplayName(clientDisplayName(client));
  return brand || fallback;
}

function clientIdsInText(detail: string): number[] {
  const ids = new Set<number>();
  for (const match of detail.matchAll(/\b(?:clients?|insight)\s+([\d,\s]+)/gi)) {
    for (const part of match[1]!.split(/[,\s]+/)) {
      const id = Number(part);
      if (Number.isFinite(id) && id > 0) ids.add(id);
    }
  }
  return [...ids];
}

function placementStillUnknown(row: TodayPlacementRow): boolean {
  const status = String(row.status ?? "").trim().toUpperCase();
  if (status !== "UNKNOWN" && status !== "") return false;
  const scored =
    typeof row.googleInboxPercent === "number" ||
    typeof row.microsoftInboxPercent === "number";
  return !scored;
}

export function buildTodayBoard(input: {
  now?: Date;
  hourlySweepEnabled: boolean;
  cronHealth: string;
  checks: CampaignCheckRecord[];
  genericFindings?: string[];
  campaigns?: TodayCampaignRef[];
  clients?: SmartleadClientRecord[];
  placements?: TodayPlacementRow[];
  /** generatedAt of the placement snapshot; stale snapshots are skipped. */
  placementsGeneratedAt?: string | null;
  isolation?: TodayIsolationHit[];
  callingLanes?: TodayLaneHit[];
  linkedinLanes?: TodayLaneHit[];
  restRollover: TodayBoard["restRollover"];
  statusById?: Map<number, string>;
}): TodayBoard {
  const now = input.now ?? new Date();
  const clients = input.clients ?? [];
  const clientById = new Map(clients.map((client) => [client.id, client]));
  const campaignById = new Map(
    (input.campaigns ?? []).map((campaign) => [campaign.id, campaign]),
  );
  const buckets = new Map<string, ClientBucket>();

  const resolveCampaign = (
    campaignId: number,
    name: string,
  ): { clientId: string; clientName: string } | null => {
    const campaign = campaignById.get(campaignId);
    const label = campaign?.name || name;
    if (isAnyShellCampaign({ name: label })) return null;
    const clientId = campaign?.client_id;
    if (typeof clientId === "number" && clientId > 0) {
      const named = clientNameOf(clientById.get(clientId), "");
      if (named) return { clientId: String(clientId), clientName: named };
    }
    const matched = clients.length
      ? matchClientForCampaign(label, clients)
      : null;
    if (matched) {
      const named = clientNameOf(matched, "");
      if (named) return { clientId: String(matched.id), clientName: named };
    }
    const head = label.split(/[|–—-]/)[0]?.trim() ?? "";
    if (head.length >= 2) return { clientId: `name:${head.toLowerCase()}`, clientName: head };
    return null;
  };

  const bucketFor = (clientId: string, clientName: string): ClientBucket => {
    const existing = buckets.get(clientId);
    if (existing) return existing;
    const created: ClientBucket = {
      clientId,
      clientName,
      failures: new Map(),
      pending: new Map(),
      info: new Map(),
    };
    buckets.set(clientId, created);
    return created;
  };

  const pushFailure = (
    clientId: string,
    clientName: string,
    column: TodayColumnId,
    failure: TodayFailure,
  ) => {
    const bucket = bucketFor(clientId, clientName);
    const list = bucket.failures.get(column) ?? [];
    if (list.some((row) => row.id === failure.id)) return;
    list.push(failure);
    bucket.failures.set(column, list);
  };

  const active = input.checks.filter((record) =>
    campaignCheckIsActive(record, input.statusById),
  );
  let lastSweepMs = 0;
  let lastSweepAt: string | null = null;
  for (const record of active) {
    if (record.lastSweepAt) {
      const ms = Date.parse(record.lastSweepAt);
      if (Number.isFinite(ms) && ms >= lastSweepMs) {
        lastSweepMs = ms;
        lastSweepAt = record.lastSweepAt;
      }
    }
    const who = resolveCampaign(record.campaignId, record.name);
    if (!who) continue;
    bucketFor(who.clientId, who.clientName);
    for (const finding of record.findings ?? []) {
      const kind = findingKind(finding);
      const column = columnForKind(kind);
      if (!column) continue;
      const detail = finding.slice(kind.length + 1).trim() || finding;
      if (TODAY_INFO_KINDS.has(kind)) {
        const infoBucket = bucketFor(who.clientId, who.clientName);
        infoBucket.info.set(column, (infoBucket.info.get(column) ?? 0) + 1);
        continue;
      }
      const action = actionFor(kind);
      pushFailure(who.clientId, who.clientName, column, {
        id: `${record.campaignId}:${kind}:${detail}`.slice(0, 180),
        text: `${record.name}: ${detail}`,
        ...action,
      });
    }
  }

  for (const finding of input.genericFindings ?? []) {
    const kind = findingKind(finding);
    const column = columnForKind(kind);
    if (!column) continue;
    const detail = finding.slice(kind.length + 1).trim() || finding;
    const ids = clientIdsInText(detail);
    const targets = ids.length
      ? ids.flatMap((id) => {
          const named = clientNameOf(clientById.get(id), "");
          return named ? [{ clientId: String(id), clientName: named }] : [];
        })
      : [];
    for (const target of targets) {
      if (TODAY_INFO_KINDS.has(kind)) {
        const infoBucket = bucketFor(target.clientId, target.clientName);
        infoBucket.info.set(column, (infoBucket.info.get(column) ?? 0) + 1);
        continue;
      }
      const action = actionFor(kind);
      pushFailure(target.clientId, target.clientName, column, {
        id: `pool:${kind}:${detail}`.slice(0, 180),
        text: detail,
        ...action,
      });
    }
  }

  // A test with no score yet is still running: grey "pending", never a
  // red. Only ACTIVE campaigns count, and a stale snapshot (the
  // Placements tab not opened for hours) is skipped rather than shown.
  const snapshotMs = input.placementsGeneratedAt
    ? Date.parse(input.placementsGeneratedAt)
    : Number.NaN;
  const snapshotFresh =
    !input.placementsGeneratedAt ||
    (Number.isFinite(snapshotMs) &&
      now.getTime() - snapshotMs <= TODAY_PLACEMENT_SNAPSHOT_MAX_AGE_MS);
  for (const row of snapshotFresh ? (input.placements ?? []) : []) {
    if (!placementStillUnknown(row) || row.campaignId == null) continue;
    if (input.statusById) {
      const status = String(input.statusById.get(row.campaignId) ?? "").toUpperCase();
      if (status !== "ACTIVE") continue;
    }
    const who = resolveCampaign(
      row.campaignId,
      row.campaignName || `Campaign ${row.campaignId}`,
    );
    if (!who) continue;
    const bucket = bucketFor(who.clientId, who.clientName);
    bucket.pending.set("placement", (bucket.pending.get("placement") ?? 0) + 1);
  }

  const laneHits = { calling: new Set<string>(), linkedin: new Set<string>() };
  const applyLane = (column: "calling" | "linkedin", lanes: TodayLaneHit[] | undefined) => {
    if (!lanes) return;
    const claimed = new Set<string>();
    for (const bucket of buckets.values()) {
      const hit = lanes.find((lane) => sameClient(lane.clientName, bucket.clientName));
      if (!hit) continue;
      laneHits[column].add(bucket.clientId);
      claimed.add(callingClientKey(hit.clientName));
      if (hit.ok) continue;
      for (const failure of hit.failures) {
        pushFailure(bucket.clientId, bucket.clientName, column, {
          id: `${column}:${failure.id}`,
          text: failure.text,
          actionId: "open-fix",
          actionLabel: "Open in Fix queue",
        });
      }
    }
    for (const hit of lanes) {
      if ([...claimed].some((key) => sameClient(key, hit.clientName))) continue;
      const clientId = `name:${callingClientKey(hit.clientName)}`;
      bucketFor(clientId, hit.clientName);
      laneHits[column].add(clientId);
      if (hit.ok) continue;
      for (const failure of hit.failures) {
        pushFailure(clientId, hit.clientName, column, {
          id: `${column}:${failure.id}`,
          text: failure.text,
          actionId: "open-fix",
          actionLabel: "Open in Fix queue",
        });
      }
    }
  };
  applyLane("calling", input.callingLanes);
  applyLane("linkedin", input.linkedinLanes);

  for (const hit of input.isolation ?? []) {
    const who = resolveCampaign(
      hit.campaignId,
      hit.campaignName || `Campaign ${hit.campaignId}`,
    );
    if (!who) continue;
    const action = actionFor("isolation_open");
    pushFailure(who.clientId, who.clientName, "isolation", {
      id: `isolation:${hit.campaignId}:${hit.text}`.slice(0, 180),
      text: hit.text,
      ...action,
    });
  }

  const columns = todayColumns();
  const rows: TodayClientRow[] = [...buckets.values()]
    .map((bucket) => {
      const cells = {} as Record<TodayColumnId, TodayCell>;
      for (const column of columns) {
        const failures = bucket.failures.get(column.id) ?? [];
        const laneBacked = column.id === "calling" || column.id === "linkedin";
        const supplied = laneBacked && (column.id === "calling" ? input.callingLanes : input.linkedinLanes);
        const idle = Boolean(supplied && !laneHits[column.id as "calling" | "linkedin"].has(bucket.clientId) && failures.length === 0);
        const pending = bucket.pending.get(column.id) ?? 0;
        cells[column.id] = {
          ok: failures.length === 0,
          idle,
          ...(pending && failures.length === 0 ? { pending } : {}),
          ...(bucket.info.get(column.id) ? { info: bucket.info.get(column.id) } : {}),
          failures,
        };
      }
      return {
        clientId: bucket.clientId,
        clientName: bucket.clientName,
        cells,
      };
    })
    .sort((a, b) => a.clientName.localeCompare(b.clientName));

  let checksPassing = 0;
  let checksFailing = 0;
  let clientsAllGreen = 0;
  for (const row of rows) {
    let green = true;
    for (const column of columns) {
      const cell = row.cells[column.id];
      if (cell.idle) continue;
      if (cell.ok) checksPassing += 1;
      else {
        checksFailing += 1;
        green = false;
      }
    }
    if (green) clientsAllGreen += 1;
  }

  return {
    lastSweepAt,
    nextSweepAt: nextHourlySweep(now).toISOString(),
    hourlySweep: input.hourlySweepEnabled ? "on" : "off",
    canonCheck: canonCheckLabel(input.cronHealth),
    alertsLabel: OPS_ALERTS_LABEL,
    checksPassing,
    checksFailing,
    clientsAllGreen,
    clientsTotal: rows.length,
    columns,
    rows,
    restRollover: input.restRollover,
  };
}
