/**
 * Hourly /ops reading. Not started at boot.
 * Watchdog sends and leads follow campaign-watchdog analytics.
 * Calling counts come from the campaignintelligence snapshot RPC.
 * HeyReach keys are read server-side and never stored or logged.
 */

import { isAnyShellCampaign } from "../lib/canaryShell.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import { clientDisplayName, type SmartleadClientRecord } from "../clients/smartlead.js";
import type { CallingSnapshot } from "../ops/callingBoard.js";
import {
  parseTodayVolume,
  parseWatchdogLeadsLeft,
  WATCHDOG_DAILY_TARGET,
  ymdInZone,
} from "../ops/campaignWatchdogVolume.js";
import type { LinkedInClientInput, LinkedInLaneInput, LinkedInReason, LinkedInSnapshot } from "../ops/linkedinBoard.js";
import type {
  WatchdogCampaignReading,
  WatchdogSnapshot,
  WatchdogSnapshotClient,
} from "../ops/watchdogBoard.js";
import type { StateStore } from "../state/store.js";

const LINKEDIN_REPLIES_CHANNEL = "C0CET7NL485";
const CLIENT_NAMES: Record<string, string> = {
  salesglider: "SalesGlider",
  techevo: "TechEvo",
  techevolution: "TechEvo",
  parlay: "Parlay",
  nutter: "Nutter",
  powergryd: "PowerGRYD",
  emcor: "EMCOR",
  vector: "Vector",
  bolder: "Bolder",
  goliath: "Goliath",
};

export interface OpsCampaignRef {
  id: number;
  name: string;
  status?: string | null;
  client_id?: number | null;
}

export interface OpsBoardSupabase {
  url: string;
  serviceRoleKey: string;
}

export function gabeDialsTargetFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = String(env.GABE_DIALS_TARGET ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function callingActionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.OPS_CALLING_ACTIONS ?? "").trim() === "1";
}

function clientLabel(name: string): string {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return CLIENT_NAMES[key] ?? name;
}

function redact(text: string, secret: string): string {
  const cleaned = secret ? text.split(secret).join("[redacted]") : text;
  return cleaned.replace(/[A-Za-z0-9_\-]{24,}/g, "[redacted]").slice(0, 180);
}

export class OpsBoardRefresh {
  constructor(
    private readonly deps: {
      state: StateStore;
      campaigns: () => OpsCampaignRef[];
      clients: () => SmartleadClientRecord[];
      analyticsByDate: (campaignId: number, day: string, signal: AbortSignal) => Promise<unknown>;
      analytics: (campaignId: number, signal: AbortSignal) => Promise<unknown>;
      supabase: () => OpsBoardSupabase | null;
      slackToken: () => string;
      gabeDialsTarget: () => number | null;
      repliesChannel?: string;
      now?: () => Date;
      sleep?: (ms: number) => Promise<void>;
      budgetMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private inFlight: Promise<{
    watchdogClients: number;
    callingClients: number;
    linkedinClients: number;
  }> | null = null;

  /** One reading at a time: a retry after health joins a pass in flight. */
  run(now = this.deps.now?.() ?? new Date()): Promise<{
    watchdogClients: number;
    callingClients: number;
    linkedinClients: number;
  }> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnce(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runOnce(now: Date): Promise<{
    watchdogClients: number;
    callingClients: number;
    linkedinClients: number;
  }> {
    const [watchdog, calling, linkedin] = await Promise.all([
      this.watchdog(now).catch((error) => {
        console.warn("[ops-board] watchdog reading failed", error instanceof Error ? error.message : "error");
        return null;
      }),
      this.calling(now).catch((error) => {
        console.warn("[ops-board] calling reading failed", error instanceof Error ? error.message : "error");
        return null;
      }),
      this.linkedin(now).catch((error) => {
        console.warn("[ops-board] linkedin reading failed", error instanceof Error ? error.message : "error");
        return null;
      }),
    ]);
    if (watchdog) this.deps.state.replaceOpsWatchdog(watchdog);
    if (calling) this.deps.state.replaceOpsCalling(calling);
    if (linkedin) this.deps.state.replaceOpsLinkedin(linkedin);
    if (watchdog || calling || linkedin) {
      await this.deps.state.save();
    }
    console.log(
      `[ops-board] hourly reading watchdog=${watchdog?.clients.length ?? "skip"} calling=${calling?.clients.length ?? "skip"} linkedin=${linkedin?.clients.length ?? "skip"}`,
    );
    return {
      watchdogClients: watchdog?.clients.length ?? 0,
      callingClients: calling?.clients.length ?? 0,
      linkedinClients: linkedin?.clients.length ?? 0,
    };
  }

  /**
   * One pass over ACTIVE client campaigns. Each campaign keeps its own
   * reading; a campaign this pass could not read (429, error, budget)
   * keeps its last reading — today's sends only from today's pass, leads
   * for WATCHDOG_LEADS_CARRY_MS — and the client says how many of its
   * campaigns are counted. A pass never replaces the board with fewer
   * readings than it had: before this, a starved pass stored zero clients.
   */
  private async watchdog(now: Date): Promise<WatchdogSnapshot | null> {
    const day = ymdInZone(now);
    const prior = this.priorWatchdog();
    const priorById = new Map<number, WatchdogCampaignReading>();
    for (const reading of prior?.campaigns ?? []) priorById.set(reading.id, reading);
    const priorNames = new Map<string, string>();
    for (const client of prior?.clients ?? []) priorNames.set(client.clientId, client.clientName);

    const names = new Map<number, string>();
    for (const client of this.deps.clients()) {
      const name = brandFromClientDisplayName(clientDisplayName(client));
      if (name) names.set(client.id, name);
    }
    const selected = selectWatchdogCampaigns(this.deps.campaigns());
    if (selected.length === 0) {
      // Inventory not published yet (or empty) — keep the last board.
      console.warn("[ops-board] watchdog: no ACTIVE client campaigns in the inventory book — keeping the last reading");
      return null;
    }
    // Oldest reading first, so a pass the budget cuts short still moves
    // every campaign forward across passes.
    const order = [...selected].sort(
      (a, b) => readAt(priorById.get(a.id)) - readAt(priorById.get(b.id)),
    );

    const controller = new AbortController();
    const budget = this.deps.budgetMs ?? 8 * 60 * 1000;
    const timer = setTimeout(() => controller.abort(), budget);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    aborted.catch(() => undefined);
    const fresh = new Map<number, WatchdogCampaignReading>();
    let failed = 0;
    let partial = false;
    try {
      for (const campaign of order) {
        if (controller.signal.aborted) {
          partial = true;
          break;
        }
        try {
          // The shared limiter queue is not abortable, so race the budget.
          const [todayRaw, leadRaw] = await Promise.race([
            Promise.all([
              this.deps.analyticsByDate(campaign.id, day, controller.signal),
              this.deps.analytics(campaign.id, controller.signal),
            ]),
            aborted,
          ]);
          fresh.set(campaign.id, {
            id: campaign.id,
            clientId: String(campaign.client_id),
            day,
            sendsToday: Math.max(0, parseTodayVolume(todayRaw, day).sent),
            leadsLeft: parseWatchdogLeadsLeft(leadRaw),
            readAt: now.toISOString(),
          });
        } catch (error) {
          if (controller.signal.aborted) {
            partial = true;
            break;
          }
          failed += 1;
          partial = true;
          const message = error instanceof Error ? error.message : "error";
          console.warn(`[ops-board] campaign ${campaign.id} analytics failed: ${redact(message, "")}`);
        }
        await (this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(40);
      }
    } finally {
      clearTimeout(timer);
    }

    const leadsFloor = now.getTime() - WATCHDOG_LEADS_CARRY_MS;
    const campaigns: WatchdogCampaignReading[] = [];
    const grouped = new Map<string, WatchdogSnapshotClient>();
    for (const campaign of selected) {
      const clientId = String(campaign.client_id);
      const clientName =
        names.get(campaign.client_id) ?? priorNames.get(clientId) ?? `Client ${clientId}`;
      const row = grouped.get(clientId) ?? {
        clientId,
        clientName,
        sendsToday: 0,
        leadsLeft: null,
        campaigns: 0,
        sendsRead: 0,
        leadsRead: 0,
      };
      row.campaigns = (row.campaigns ?? 0) + 1;
      const reading = fresh.get(campaign.id) ?? carryOver(priorById.get(campaign.id), day, leadsFloor);
      if (reading) {
        campaigns.push({ ...reading, clientId });
        if (reading.sendsToday != null) {
          row.sendsToday += reading.sendsToday;
          row.sendsRead = (row.sendsRead ?? 0) + 1;
        }
        if (reading.leadsLeft != null) {
          row.leadsLeft = (row.leadsLeft ?? 0) + reading.leadsLeft;
          row.leadsRead = (row.leadsRead ?? 0) + 1;
        }
      }
      grouped.set(clientId, row);
    }
    console.log(
      `[ops-board] watchdog day=${day} campaigns=${selected.length} read=${fresh.size} failed=${failed} carried=${campaigns.length - fresh.size}${partial ? " partial" : ""}`,
    );
    return {
      updatedAt: now.toISOString(),
      partial,
      day,
      paceTarget: WATCHDOG_DAILY_TARGET,
      source: "campaign-watchdog-analytics",
      clients: [...grouped.values()],
      campaigns,
    };
  }

  private priorWatchdog(): WatchdogSnapshot | null {
    const state = this.deps.state as Partial<Pick<StateStore, "getOpsBoard">>;
    return typeof state.getOpsBoard === "function" ? state.getOpsBoard().watchdog ?? null : null;
  }

  private async calling(now: Date): Promise<CallingSnapshot | null> {
    const supabase = this.deps.supabase();
    if (!supabase) return null;
    const payload = await this.rpc(supabase, "ops_calling_snapshot");
    const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    if (!root) return null;
    const clients = Array.isArray(root.clients) ? root.clients : [];
    const numbers = Array.isArray(root.numbers) ? root.numbers : [];
    const suppression = root.suppression && typeof root.suppression === "object"
      ? root.suppression as Record<string, unknown>
      : {};
    const tagging = root.tagging && typeof root.tagging === "object"
      ? root.tagging as Record<string, unknown>
      : {};
    return {
      updatedAt: now.toISOString(),
      partial: false,
      edgeLogs: "unchecked",
      gabeDialsYesterday: numberOrZero(root.gabeDialsYesterday),
      gabeDialsTarget: this.deps.gabeDialsTarget(),
      suppression: {
        dnc: numberOrZero(suppression.dnc),
        dncStillQueued: numberOrZero(suppression.dncStillQueued),
        unsub: numberOrZero(suppression.unsub),
        unsubStillQueued: numberOrZero(suppression.unsubStillQueued),
        unsubStillEmailed: numberOrZero(suppression.unsubStillEmailed),
      },
      tagging: {
        voicemailCalls: numberOrZero(tagging.voicemailCalls),
        voicemailTagged: numberOrZero(tagging.voicemailTagged),
        untaggedOver30s: numberOrZero(tagging.untaggedOver30s),
      },
      clients: clients.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const item = row as Record<string, unknown>;
        const clientName = clientLabel(String(item.clientName ?? ""));
        if (!clientName || clientName.includes("@")) return [];
        return [{
          clientName,
          queueContacts: numberOrZero(item.queueContacts),
          queues: numberOrZero(item.queues),
          queuesFull: numberOrZero(item.queuesFull),
          missingEmail: numberOrZero(item.missingEmail),
          queuesCalled3: numberOrZero(item.queuesCalled3),
          voicemailsYesterday: numberOrZero(item.voicemailsYesterday),
          emailsYesterday: numberOrZero(item.emailsYesterday),
          mismatchReason: mismatchReason(item.mismatchReason),
          routerErrors: numberOrZero(item.routerErrors),
          dncHookErrors: null,
        }];
      }),
      numbers: numbers.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const item = row as Record<string, unknown>;
        const last4 = String(item.last4 ?? "").replace(/\D/g, "").slice(-4);
        const clientName = clientLabel(String(item.clientName ?? ""));
        if (!clientName || last4.length !== 4) return [];
        return [{
          clientName,
          label: clientLabel(String(item.label ?? clientName)).slice(0, 40),
          last4,
          daysSinceRotation: item.daysSinceRotation == null ? null : numberOrZero(item.daysSinceRotation),
          spamLikely: item.spamLikely === true ? true : item.spamLikely === false ? false : null,
        }];
      }),
    };
  }

  private async linkedin(now: Date): Promise<LinkedInSnapshot> {
    const day = ymdInZone(now, "America/Chicago");
    const repliesToday = await this.replies(now);
    const supabase = this.deps.supabase();
    const clients: LinkedInClientInput[] = [];
    const seen = new Set<string>();
    if (supabase) {
      try {
        const rows = await this.rpc(supabase, "ops_heyreach_workspaces");
        const workspaces = Array.isArray(rows) ? rows : [];
        for (const row of workspaces) {
          if (!row || typeof row !== "object") continue;
          const item = row as Record<string, unknown>;
          const slug = String(item.slug ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
          const secret = String(item.secret ?? "");
          if (!slug || slug.includes("master") || slug.includes("mcp") || !secret) continue;
          const clientName = CLIENT_NAMES[slug] ?? slug;
          seen.add(clientName.toLowerCase());
          try {
            const lanes = await this.heyreachLanes(secret, day);
            clients.push({ clientName, checked: true, keyState: "ok", lanes });
          } catch (error) {
            const invalid = error instanceof Error && error.name === "HeyReachAuthError";
            console.warn(`[ops-board] linkedin ${clientName} ${invalid ? "key invalid" : "read failed"}`);
            clients.push({
              clientName,
              checked: false,
              keyState: invalid ? "invalid" : "ok",
              lanes: invalid ? [] : [{
                label: clientName,
                sentToday: null,
                trend: [],
                pending: null,
                status: "",
                reason: "can't check",
              }],
            });
          }
        }
      } catch (error) {
        console.warn(
          "[ops-board] heyreach vault read failed",
          redact(error instanceof Error ? error.message : "error", ""),
        );
      }
    }
    if (!seen.has("powergryd")) {
      clients.push({ clientName: "PowerGRYD", checked: false, keyState: "missing", lanes: [] });
    }
    return {
      updatedAt: now.toISOString(),
      partial: false,
      repliesToday,
      clients,
    };
  }

  private async heyreachLanes(apiKey: string, today: string): Promise<LinkedInLaneInput[]> {
    const listed = await this.heyreach(apiKey, "campaign/GetAll", {
      method: "POST",
      body: JSON.stringify({ offset: 0, limit: 100 }),
    });
    const items = campaignItems(listed);
    const days = recentDays(today, 3);
    const lanes: LinkedInLaneInput[] = [];
    for (const campaign of items.slice(0, 12)) {
      let stats: unknown = null;
      try {
        stats = await this.heyreach(apiKey, "stats/GetOverallStats", {
          method: "POST",
          body: JSON.stringify({
            accountIds: [],
            campaignIds: [campaign.id],
            startDate: `${days[0]}T00:00:00.000Z`,
            endDate: `${days[days.length - 1]}T23:59:59.999Z`,
          }),
        });
      } catch (error) {
        if (error instanceof Error && error.name === "HeyReachAuthError") throw error;
        stats = null;
      }
      const byDay = connectionsByDay(stats);
      const trend = days.map((day) => byDay.get(day) ?? 0);
      const sentToday = byDay.has(today) ? byDay.get(today)! : trend[trend.length - 1] ?? null;
      lanes.push({
        label: laneLabel(campaign.name, lanes.length),
        sentToday,
        trend,
        pending: campaign.pending,
        status: campaign.status,
        reason: laneReason(campaign),
      });
    }
    if (!lanes.length) {
      lanes.push({
        label: "Workspace",
        sentToday: 0,
        trend: days.map(() => 0),
        pending: 0,
        status: "",
        reason: "out of leads",
      });
    }
    return lanes;
  }

  private async heyreach(apiKey: string, path: string, init: RequestInit): Promise<unknown> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`https://api.heyreach.io/api/public/${path}`, {
        ...init,
        headers: {
          "X-API-KEY": apiKey,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      throw new Error(redact(error instanceof Error ? error.message : "network", apiKey));
    }
    if (response.status === 401 || response.status === 403) {
      const error = new Error("HeyReach key is invalid");
      error.name = "HeyReachAuthError";
      throw error;
    }
    if (!response.ok) throw new Error(`HeyReach ${response.status}`);
    return response.json();
  }

  private async replies(now: Date): Promise<number | null> {
    const token = this.deps.slackToken().trim();
    if (!token) return null;
    const oldest = String(Math.floor(chicagoMidnight(now).getTime() / 1000));
    const channel = this.deps.repliesChannel ?? LINKEDIN_REPLIES_CHANNEL;
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    let cursor = "";
    let count = 0;
    for (let page = 0; page < 5; page += 1) {
      const url = new URL("https://slack.com/api/conversations.history");
      url.searchParams.set("channel", channel);
      url.searchParams.set("oldest", oldest);
      url.searchParams.set("limit", "200");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) return null;
      const body = await response.json() as { ok?: boolean; messages?: unknown[]; response_metadata?: { next_cursor?: string } };
      if (!body.ok || !Array.isArray(body.messages)) return null;
      count += body.messages.length;
      cursor = body.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    return count;
  }

  private async rpc(supabase: OpsBoardSupabase, fn: string): Promise<unknown> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const response = await fetchImpl(`${supabase.url.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: supabase.serviceRoleKey,
        Authorization: `Bearer ${supabase.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!response.ok) throw new Error(`supabase rpc ${fn} ${response.status}`);
    return response.json();
  }
}

function numberOrZero(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function mismatchReason(value: unknown): CallingSnapshot["clients"][number]["mismatchReason"] {
  if (value === "contact had no email" || value === "router timeout" || value === "router skip" || value === "dnc hook") {
    return value;
  }
  return null;
}

function chicagoMidnight(now: Date): Date {
  const ymd = ymdInZone(now, "America/Chicago");
  const sample = new Date(`${ymd}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    timeZoneName: "shortOffset",
  }).formatToParts(sample).find((part) => part.type === "timeZoneName")?.value ?? "GMT-6";
  const match = offset.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  const hours = match ? Number(match[1]) : -6;
  const minutes = match?.[2] ? Number(match[2]) : 0;
  const sign = hours < 0 ? -1 : 1;
  const totalMinutes = hours * 60 + sign * minutes;
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - totalMinutes * 60 * 1000);
}

function recentDays(today: string, count: number): string[] {
  const [year, month, day] = today.split("-").map(Number);
  const start = new Date(Date.UTC(year!, month! - 1, day));
  const days: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() - offset);
    days.push(date.toISOString().slice(0, 10));
  }
  return days;
}

function campaignItems(raw: unknown): Array<{ id: number; name: string; status: string; pending: number | null; inProgress: number | null; failed: number | null; limit: number | null }> {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const list = Array.isArray(raw) ? raw : Array.isArray(root.items) ? root.items : Array.isArray(root.data) ? root.data : [];
  return list.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const id = numberOrZero(item.id);
    const name = String(item.name ?? item.campaignName ?? "").trim();
    if (!id || !name || name.includes("@")) return [];
    const progress = item.progressStats && typeof item.progressStats === "object"
      ? item.progressStats as Record<string, unknown>
      : item;
    return [{
      id,
      name: name.slice(0, 80),
      status: String(item.status ?? ""),
      pending: progress.totalUsersPending == null && progress.pending == null
        ? null
        : numberOrZero(progress.totalUsersPending ?? progress.pending),
      inProgress: progress.totalUsersInProgress == null && progress.inProgress == null
        ? null
        : numberOrZero(progress.totalUsersInProgress ?? progress.inProgress),
      failed: progress.totalUsersFailed == null ? null : numberOrZero(progress.totalUsersFailed),
      limit: item.dailyLimit == null && item.limit == null ? null : numberOrZero(item.dailyLimit ?? item.limit),
    }];
  });
}

function connectionsByDay(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!root) return out;
  const byDay = root.byDayStats ?? root.by_day_stats ?? root.dailyStats;
  if (byDay && typeof byDay === "object" && !Array.isArray(byDay)) {
    for (const [day, value] of Object.entries(byDay as Record<string, unknown>)) {
      const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
      out.set(day.slice(0, 10), numberOrZero(row.connectionsSent ?? row.connections_sent ?? row.connectionRequestsSent));
    }
  }
  return out;
}

function laneReason(campaign: { status: string; pending: number | null; inProgress: number | null; failed: number | null; limit: number | null }): LinkedInReason | null {
  const status = campaign.status.toUpperCase();
  if (status.includes("DISCONNECT")) return "disconnected";
  if (status.includes("COOL")) return "cooldown";
  if (status.includes("PAUS") && (campaign.pending ?? 0) > 0) return "paused campaign holding leads";
  if ((campaign.pending ?? 0) <= 0 && (campaign.inProgress ?? 0) <= 0) return "out of leads";
  if (campaign.limit != null && campaign.limit > 0 && campaign.limit < 30) return "low limit";
  if ((campaign.failed ?? 0) > 0 && (campaign.failed ?? 0) >= (campaign.inProgress ?? 0)) {
    return "most prospects inactive";
  }
  return "low";
}

function laneLabel(name: string, index: number): string {
  if (name.includes("@")) return `Sender ${index + 1}`;
  return name.slice(0, 80);
}

/** Leads change slowly; a lead reading is reused for up to six hours. */
export const WATCHDOG_LEADS_CARRY_MS = 6 * 60 * 60 * 1000;

/** ACTIVE, non-shell campaigns that belong to a Smartlead client. */
export function selectWatchdogCampaigns(
  campaigns: OpsCampaignRef[],
): Array<OpsCampaignRef & { client_id: number }> {
  return campaigns.filter(
    (campaign): campaign is OpsCampaignRef & { client_id: number } =>
      String(campaign.status ?? "").toUpperCase() === "ACTIVE" &&
      !isAnyShellCampaign(campaign) &&
      typeof campaign.client_id === "number" &&
      campaign.client_id > 0,
  );
}

function readAt(reading: WatchdogCampaignReading | undefined): number {
  const at = reading ? Date.parse(reading.readAt) : NaN;
  return Number.isFinite(at) ? at : 0;
}

function carryOver(
  reading: WatchdogCampaignReading | undefined,
  day: string,
  leadsFloorMs: number,
): WatchdogCampaignReading | null {
  if (!reading) return null;
  const sendsToday = reading.day === day ? reading.sendsToday : null;
  const leadsLeft = readAt(reading) >= leadsFloorMs ? reading.leadsLeft : null;
  if (sendsToday == null && leadsLeft == null) return null;
  return { ...reading, sendsToday, leadsLeft };
}

function abortError(): Error {
  const error = new Error("ops-board watchdog budget reached");
  error.name = "AbortError";
  return error;
}
