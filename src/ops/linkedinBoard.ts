/**
 * SOP 6 LinkedIn board. One card per client. Sender lanes sit inside it.
 * Connection counts only. No message text and no lead names.
 */

export const LINKEDIN_TARGET_MIN = 30;
export const LINKEDIN_TARGET_MAX = 35;
export const LINKEDIN_BROKEN_MAX = 3;

export type LinkedInTone = "green" | "amber" | "red" | "unchecked";

export type LinkedInReason =
  | "out of leads"
  | "paused campaign holding leads"
  | "cooldown"
  | "disconnected"
  | "low limit"
  | "most prospects inactive"
  | "low"
  | "no HeyReach key"
  | "HeyReach key is invalid"
  | "can't check";

export interface LinkedInLaneInput {
  label: string;
  sentToday: number | null;
  trend: number[];
  pending: number | null;
  status: string;
  reason: LinkedInReason | null;
}

export interface LinkedInClientInput {
  clientName: string;
  checked: boolean;
  keyState: "ok" | "missing" | "invalid";
  lanes: LinkedInLaneInput[];
}

export interface LinkedInSnapshot {
  updatedAt: string;
  partial: boolean;
  repliesToday: number | null;
  clients: LinkedInClientInput[];
}

export interface LinkedInLaneView {
  label: string;
  sentToday: number | null;
  trend: number[];
  tone: LinkedInTone;
  reason: string | null;
}

export interface LinkedInClientCard {
  clientName: string;
  sentToday: number | null;
  trend: number[];
  tone: LinkedInTone;
  reason: string | null;
  lanes: LinkedInLaneView[];
  ok: boolean;
  failures: Array<{ id: string; text: string }>;
}

export interface LinkedInBoard {
  updatedAt: string | null;
  targetLabel: string;
  onTarget: number;
  low: number;
  broken: number;
  unchecked: number;
  repliesToday: number | null;
  clients: LinkedInClientCard[];
}

export function laneTone(lane: LinkedInLaneInput, keyState: LinkedInClientInput["keyState"]): {
  tone: LinkedInTone;
  reason: string | null;
} {
  if (keyState === "missing") return { tone: "unchecked", reason: "no HeyReach key" };
  if (keyState === "invalid") return { tone: "unchecked", reason: "HeyReach key is invalid" };
  if (!Number.isFinite(lane.sentToday ?? NaN)) {
    return { tone: "unchecked", reason: lane.reason ?? "can't check" };
  }
  const sent = lane.sentToday ?? 0;
  const trend = lane.trend.filter((value) => Number.isFinite(value));
  const tail = trend.slice(-3);
  const lowStreak = tail.length >= 2 && tail.every((value) => value < LINKEDIN_TARGET_MIN);
  if (sent <= LINKEDIN_BROKEN_MAX || lowStreak) {
    return { tone: "red", reason: "broken, tag Josh" };
  }
  if (sent >= LINKEDIN_TARGET_MIN && sent <= LINKEDIN_TARGET_MAX) {
    return { tone: "green", reason: null };
  }
  return { tone: "amber", reason: lane.reason ?? "low" };
}

function sumTrend(lanes: LinkedInLaneView[]): number[] {
  const length = Math.max(0, ...lanes.map((lane) => lane.trend.length));
  const totals: number[] = [];
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    let seen = false;
    for (const lane of lanes) {
      const value = lane.trend[index];
      if (value == null || !Number.isFinite(value)) continue;
      sum += value;
      seen = true;
    }
    totals.push(seen ? sum : 0);
  }
  return totals;
}

export function buildLinkedInBoard(input: {
  snapshot?: LinkedInSnapshot | null;
}): LinkedInBoard {
  const snapshot = input.snapshot ?? null;
  const clients = (snapshot?.clients ?? [])
    .map((client) => {
      const lanes = client.lanes.map((lane) => {
        const judged = laneTone(lane, client.keyState);
        return {
          label: lane.label,
          sentToday: lane.sentToday,
          trend: lane.trend.filter((value) => Number.isFinite(value)).slice(-3),
          tone: judged.tone,
          reason: judged.reason,
        };
      });
      const sentToday = lanes.some((lane) => lane.sentToday != null)
        ? lanes.reduce((sum, lane) => sum + (lane.sentToday ?? 0), 0)
        : null;
      const trend = sumTrend(lanes);
      const judged = laneTone(
        {
          label: client.clientName,
          sentToday,
          trend,
          pending: null,
          status: "",
          reason: (lanes.find((lane) => lane.reason)?.reason ?? null) as LinkedInLaneInput["reason"],
        },
        client.keyState,
      );
      const ok = judged.tone === "green";
      const failures = ok
        ? []
        : [
            {
              id: judged.tone,
              text:
                judged.tone === "unchecked"
                  ? `Can't check — ${judged.reason ?? "no working HeyReach key"}`
                  : `${sentToday ?? "—"} connection requests today${judged.reason ? ` — ${judged.reason}` : ""}`,
            },
          ];
      return {
        clientName: client.clientName,
        sentToday,
        trend,
        tone: judged.tone,
        reason: judged.reason,
        lanes,
        ok,
        failures,
      };
    })
    .sort((a, b) => a.clientName.localeCompare(b.clientName));

  return {
    updatedAt: snapshot?.updatedAt ?? null,
    targetLabel: `${LINKEDIN_TARGET_MIN}–${LINKEDIN_TARGET_MAX}`,
    onTarget: clients.filter((client) => client.tone === "green").length,
    low: clients.filter((client) => client.tone === "amber").length,
    broken: clients.filter((client) => client.tone === "red").length,
    unchecked: clients.filter((client) => client.tone === "unchecked").length,
    repliesToday: snapshot?.repliesToday ?? null,
    clients,
  };
}

export function linkedInLanes(snapshot: LinkedInSnapshot | null | undefined): Array<{
  clientName: string;
  ok: boolean;
  failures: Array<{ id: string; text: string }>;
}> {
  return buildLinkedInBoard({ snapshot }).clients.map((client) => ({
    clientName: client.clientName,
    ok: client.ok,
    failures: client.failures,
  }));
}
