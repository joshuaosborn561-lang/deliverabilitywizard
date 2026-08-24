/**
 * D63 — health Slack about thin campaigns. Never blame a generic shortage
 * on a client-inbox-only campaign.
 */

export const STAFFING_SHORT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export function staffingShortAlertKey(
  shorts: Array<{ campaignId: number; shortBy: number }>,
): string {
  const parts = [...shorts]
    .map((row) => `${row.campaignId}:${row.shortBy}`)
    .sort();
  return `health-client-short:${parts.join(",")}`;
}

export function staffingSlackLines(input: {
  dryRun?: boolean;
  assigned?: Array<{ campaignId: number; campaignName: string }>;
  resumed?: Array<{ name: string; staffable: number }>;
  stillShort?: Array<{
    name: string;
    staffable: number;
    shortBy: number;
    status: string;
  }>;
  pulledGenerics?: number;
  released?: number;
}): string[] {
  const assigned = input.assigned ?? [];
  const resumed = input.resumed ?? [];
  const stillShort = input.stillShort ?? [];
  const pulled = input.pulledGenerics ?? 0;
  const released = input.released ?? 0;

  const byCampaign = new Map<string, number>();
  for (const row of assigned) {
    const key = `#${row.campaignId} ${row.campaignName}`;
    byCampaign.set(key, (byCampaign.get(key) ?? 0) + 1);
  }

  const lines = [
    `${input.dryRun ? "Preview — " : ""}Campaign staffing`,
  ];
  if (stillShort.length) {
    lines.push(
      "Spare inboxes are not the shortage. They stay on Goliath.",
      "These campaigns are missing this client's own inboxes that should be sending this week:",
    );
  } else {
    lines.push(
      "Each client's floor is half its own inboxes. Spare inboxes stay on Goliath only.",
    );
  }
  for (const [name, n] of byCampaign) {
    lines.push(`• ${name} — added ${n} spare${n === 1 ? "" : "s"}`);
  }
  for (const row of resumed) {
    lines.push(
      `• ${row.name} — turned back on (${row.staffable} sending inboxes). This was a pause we took to protect it, not a pause someone made by hand.`,
    );
  }
  for (const row of stillShort) {
    lines.push(
      `• ${row.name} — ${row.staffable} sending, ${row.shortBy} of this client's inboxes that should be on are not (${row.status}).`,
    );
  }
  if (pulled) {
    lines.push(
      `Took ${pulled} spare membership${pulled === 1 ? "" : "s"} off every campaign that is not Goliath.`,
    );
  }
  if (released) {
    lines.push(
      `Took ${released} spare${released === 1 ? "" : "s"} off campaigns they didn’t belong on.`,
    );
  }
  return lines;
}
