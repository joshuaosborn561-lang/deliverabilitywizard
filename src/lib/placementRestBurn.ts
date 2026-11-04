/**
 * D325 — a same-ESP reading under 80% rests four weeks, then is due
 * to burn. The clock starts once. Domain deletion stays a Josh kill
 * (D51); this record is the dashboard schedule, not an automatic purge.
 */

export const PLACEMENT_REST_MS = 28 * 24 * 60 * 60 * 1000;

export interface PlacementRestBurn {
  campaignId: number;
  campaignName: string;
  startedAt: string;
  restUntil: string;
  phase: "rest" | "burn";
}

export function planPlacementRestBurn(input: {
  campaignId: number;
  campaignName: string;
  at: string;
}): PlacementRestBurn {
  const started = new Date(input.at);
  const when = Number.isNaN(started.getTime()) ? new Date() : started;
  return {
    campaignId: input.campaignId,
    campaignName: input.campaignName.replace(/\s+/g, " ").trim().slice(0, 120),
    startedAt: when.toISOString(),
    restUntil: new Date(when.getTime() + PLACEMENT_REST_MS).toISOString(),
    phase: "rest",
  };
}

export function placementRestPhase(record: PlacementRestBurn, now: Date): "rest" | "burn" {
  const until = Date.parse(record.restUntil);
  if (!Number.isFinite(until)) return "rest";
  return now.getTime() >= until ? "burn" : "rest";
}

export function placementRestText(record: PlacementRestBurn): string {
  if (record.phase === "burn") {
    return `${record.campaignName} #${record.campaignId}: rest finished — burn due`;
  }
  return `${record.campaignName} #${record.campaignId}: same-ESP under 80% — rest 4 weeks, then burn`;
}
