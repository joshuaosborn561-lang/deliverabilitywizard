/**
 * Same-ESP placement from the sender-account-wise report.
 *
 * The providerwise report groups by *seed* provider only, so a Google
 * sender landing in an Outlook seed's junk counts against "Outlook".
 * Canon same-ESP is sender ESP → seed ESP (Google sender → Gmail seeds,
 * Microsoft sender → Outlook seeds). This module rebuilds that split.
 */
import { inboxRateFromSeedDetails } from "../clients/smartdelivery.js";
import type { EspFamily } from "./esp.js";
import type { ProviderInboxSplit } from "./copySignal.js";

export const SAME_ESP_MIN_SAMPLES = 3;

function textOf(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const inner = (value as Record<string, unknown>)[key];
  return typeof inner === "string" ? inner : "";
}

/**
 * Sender ESP from the seed replies: the DKIM selector (google vs
 * selector1/selector2) and, failing that, the SPF "designates <ip>"
 * sending IP (Google 2607:f8b0 / 209.85 / 74.125; Microsoft 2a01:111 /
 * 40.x / 52.x). Undefined when the replies don't say.
 */
export function inferSenderEspFromSeedDetails(details: unknown[]): EspFamily | undefined {
  for (const item of details) {
    const reply =
      item && typeof item === "object"
        ? (item as Record<string, unknown>).reply
        : undefined;
    const r = (reply && typeof reply === "object" ? reply : {}) as Record<string, unknown>;
    const dkim = textOf(r.dkim_result, "dkim");
    const spf = textOf(r.spf_result, "spf");
    const selector = /header\.s=([a-z0-9._-]+)/i.exec(dkim)?.[1]?.toLowerCase();
    if (selector === "google") return "google";
    if (selector && /^selector[12]$/.test(selector)) return "microsoft";
    const ip = /designates\s+([0-9a-f:.]+)\s/i.exec(spf)?.[1]?.toLowerCase() ?? "";
    if (/^2607:f8b0:|^209\.85\.|^74\.125\./.test(ip)) return "google";
    if (/^2a01:111:|^40\.|^52\./.test(ip)) return "microsoft";
  }
  return undefined;
}

function rowsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["result", "data", "items"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

/**
 * Same-ESP inbox % per sender ESP family, pooled over every sender on
 * the test. Families with fewer than `minSamples` same-ESP seed
 * placements are left out (thin data is not a verdict).
 */
export function sameEspProvidersFromSenderReport(
  raw: unknown,
  minSamples = SAME_ESP_MIN_SAMPLES,
): ProviderInboxSplit[] {
  const totals: Record<"google" | "microsoft", { inbox: number; samples: number }> = {
    google: { inbox: 0, samples: 0 },
    microsoft: { inbox: 0, samples: 0 },
  };
  for (const row of rowsOf(raw)) {
    if (!row || typeof row !== "object") continue;
    const details = (row as Record<string, unknown>).details;
    if (!Array.isArray(details)) continue;
    const esp = inferSenderEspFromSeedDetails(details);
    if (esp !== "google" && esp !== "microsoft") continue;
    const same = inboxRateFromSeedDetails(details, { sameEspAs: esp });
    if (!same) continue;
    totals[esp].inbox += same.inbox;
    totals[esp].samples += same.samples;
  }
  const out: ProviderInboxSplit[] = [];
  if (totals.google.samples >= minSamples) {
    out.push({
      name: "Google → Gmail (same-ESP)",
      inboxPercent: (totals.google.inbox / totals.google.samples) * 100,
    });
  }
  if (totals.microsoft.samples >= minSamples) {
    out.push({
      name: "Microsoft → Outlook (same-ESP)",
      inboxPercent: (totals.microsoft.inbox / totals.microsoft.samples) * 100,
    });
  }
  return out;
}
