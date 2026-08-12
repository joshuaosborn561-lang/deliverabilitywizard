/**
 * Infer a Smartlead client_id for a campaign that is missing one.
 *
 * Prefer an explicit client-name hit inside the campaign name; fall back to a
 * sibling campaign that shares a leading brand token and already has a client.
 */

import type { SmartleadCampaign } from "../types/index.js";

export interface ClientMatchRow {
  id: number;
  name?: string | null;
}

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "offer",
  "tech",
  "campaign",
  "test",
  "new",
  "copy",
  "v1",
  "v2",
  "v3",
]);

export function normalizeBrand(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First meaningful token of a campaign name (e.g. "Goliath", "Nieto"). */
export function brandToken(campaignName: string): string | undefined {
  const parts = normalizeBrand(campaignName).split(" ").filter(Boolean);
  for (const p of parts) {
    if (p.length < 3 || STOP.has(p) || /^\d+$/.test(p)) continue;
    return p;
  }
  return undefined;
}

/**
 * Best client id for this campaign, or null when nothing matches confidently.
 */
export function matchClientForCampaign(
  campaign: Pick<SmartleadCampaign, "id" | "name" | "client_id">,
  clients: ClientMatchRow[],
  allCampaigns: Array<Pick<SmartleadCampaign, "id" | "name" | "client_id">>,
): { clientId: number; reason: string } | null {
  if (typeof campaign.client_id === "number" && campaign.client_id > 0) {
    return { clientId: campaign.client_id, reason: "already assigned" };
  }

  const camp = normalizeBrand(campaign.name || "");
  if (!camp) return null;

  let best: { clientId: number; score: number; reason: string } | null = null;
  for (const client of clients) {
    const name = normalizeBrand(String(client.name ?? ""));
    if (!name || !client.id) continue;
    let score = 0;
    let reason = "";
    if (camp === name) {
      score = 100;
      reason = `exact client name "${client.name}"`;
    } else if (camp.includes(name)) {
      score = 90;
      reason = `campaign name contains client "${client.name}"`;
    } else if (name.includes(camp.split(" ")[0]!)) {
      score = 70;
      reason = `client name overlaps campaign brand`;
    } else {
      const clientParts = name.split(" ").filter((p) => p.length > 2);
      const hits = clientParts.filter((p) => camp.includes(p));
      if (hits.length >= 2) {
        score = 80;
        reason = `campaign shares client tokens (${hits.join(", ")})`;
      } else if (hits.length === 1 && hits[0]!.length >= 5) {
        score = 65;
        reason = `campaign shares client token "${hits[0]}"`;
      }
    }
    if (score >= 65 && (!best || score > best.score)) {
      best = { clientId: client.id, score, reason };
    }
  }
  if (best) return { clientId: best.clientId, reason: best.reason };

  const token = brandToken(campaign.name || "");
  if (!token) return null;
  for (const other of allCampaigns) {
    if (other.id === campaign.id) continue;
    if (typeof other.client_id !== "number" || other.client_id <= 0) continue;
    if (brandToken(other.name || "") !== token) continue;
    return {
      clientId: other.client_id,
      reason: `sibling campaign #${other.id} shares brand "${token}"`,
    };
  }

  return null;
}
