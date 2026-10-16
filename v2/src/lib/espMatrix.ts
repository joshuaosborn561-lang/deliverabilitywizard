import { AZURE_ENTRA_DOMAINS } from "../canon/constants.js";
import type { EspInboxDay } from "../types.js";

export type EspSide = "G" | "MS";
export type EspLane = "G_G" | "MS_MS";

export interface EspSenderRow {
  email: string;
  inbox?: boolean;
  provider?: string;
}

export function senderEsp(email: string): EspSide {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  if (AZURE_ENTRA_DOMAINS.has(domain)) return "MS";
  if (/gmail|google|gsuite/.test(domain)) return "G";
  return "MS";
}

export function seedEsp(provider: string | undefined): EspSide {
  const p = String(provider ?? "").toLowerCase();
  if (/gmail|google/.test(p)) return "G";
  return "MS";
}

function rate(inbox: number, total: number): number | null {
  if (total <= 0) return null;
  return (inbox / total) * 100;
}

/** D273 — ESP-matched inbox rates only: G→G and MS→MS. Cross-ESP pairs are dropped. */
export function espInboxMatrix(senders: EspSenderRow[]): {
  G_G: number | null;
  MS_MS: number | null;
} {
  const buckets: Record<EspLane, { inbox: number; total: number }> = {
    G_G: { inbox: 0, total: 0 },
    MS_MS: { inbox: 0, total: 0 },
  };
  for (const row of senders) {
    if (!row.email) continue;
    const sender = senderEsp(row.email);
    const seed = seedEsp(row.provider);
    if (sender !== seed) continue;
    const lane: EspLane = sender === "G" ? "G_G" : "MS_MS";
    buckets[lane].total += 1;
    if (row.inbox) buckets[lane].inbox += 1;
  }
  return {
    G_G: rate(buckets.G_G.inbox, buckets.G_G.total),
    MS_MS: rate(buckets.MS_MS.inbox, buckets.MS_MS.total),
  };
}

export function toEspInboxDay(opts: {
  campaignId: number;
  campaignName?: string;
  day: string;
  senders: EspSenderRow[];
  testId?: string;
  source?: EspInboxDay["source"];
}): EspInboxDay {
  const m = espInboxMatrix(opts.senders);
  return {
    campaignId: opts.campaignId,
    campaignName: opts.campaignName,
    day: opts.day,
    gToG: m.G_G,
    msToMs: m.MS_MS,
    testId: opts.testId,
    source: opts.source,
  };
}
