/**
 * Apply Supabase lead categories onto a restored Smartlead campaign
 * via POST /campaigns/{id}/leads/{leadId}/category.
 *
 * Default target: MSRS2 restored (#3867944 ← old #3628940).
 *
 *   railway run -- npx tsx scripts/restore-msrs2-positives.ts --apply
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiRequest, ApiError, sleep } from "../src/lib/http.js";
import { SmartleadClient } from "../src/clients/smartlead.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data", "old-client-restore");
const BASE = "https://server.smartlead.ai/api/v1/";
const OLD_ID = 3628940;
const GAP_MS = 400;

/** Positive sentiment categories we care about for the video. */
const POSITIVE_CATEGORY_IDS = new Set([1, 2, 5, 131482]);

interface LeadRow {
  smartlead_campaign_id: number;
  email: string;
  category?: string | null;
  category_id?: number | null;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      if (status !== 429 && status < 500) throw error;
      const wait = Math.min(90_000, 5_000 * 2 ** attempt);
      console.warn(`[msrs2-positives] ${label} ${status} — wait ${wait}ms`);
      await sleep(wait);
    }
  }
  return fn();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const key = process.env.SMARTLEAD_API_KEY?.trim();
  if (!key) throw new Error("SMARTLEAD_API_KEY required");

  const map = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "restore-map.json"), "utf8"),
  ) as Record<string, number>;
  const campaignId = map[String(OLD_ID)];
  if (!campaignId) throw new Error(`no restore map for old #${OLD_ID}`);

  const leads = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "leads.json"), "utf8"),
  ) as LeadRow[];

  const positives = leads.filter((l) => {
    if (l.smartlead_campaign_id !== OLD_ID) return false;
    if (l.category_id != null && POSITIVE_CATEGORY_IDS.has(Number(l.category_id))) {
      return true;
    }
    const cat = String(l.category ?? "").toLowerCase();
    return (
      cat === "interested" ||
      cat === "positive reply" ||
      cat === "meeting request" ||
      cat === "information request"
    );
  });

  console.log(
    `[msrs2-positives] campaign #${campaignId} positives_in_dump=${positives.length} apply=${apply}`,
  );
  for (const p of positives) {
    console.log(
      `  ${p.email} category=${p.category} id=${p.category_id ?? "?"}`,
    );
  }

  // Page Smartlead leads → email → { leadId, mapId }
  const smartlead = new SmartleadClient(key);
  const byEmail = new Map<
    string,
    { leadId: number; mapId: number | null }
  >();
  let offset = 0;
  for (;;) {
    const page = (await withRetry(
      () => smartlead.getCampaignLeads(campaignId, { limit: 100, offset }),
      `list@${offset}`,
    )) as {
      data?: Array<{
        campaign_lead_map_id?: string | number;
        lead?: { id?: number; email?: string };
      }>;
    };
    const data = Array.isArray(page.data) ? page.data : [];
    for (const row of data) {
      const email = String(row.lead?.email ?? "")
        .trim()
        .toLowerCase();
      const leadId = Number(row.lead?.id);
      const mapId = row.campaign_lead_map_id
        ? Number(row.campaign_lead_map_id)
        : null;
      if (email && leadId > 0) byEmail.set(email, { leadId, mapId });
    }
    offset += data.length;
    if (data.length < 100) break;
    await sleep(GAP_MS);
  }
  console.log(`[msrs2-positives] listed ${byEmail.size} leads on #${campaignId}`);

  let ok = 0;
  let miss = 0;
  let fail = 0;
  for (const row of positives) {
    const email = String(row.email).trim().toLowerCase();
    const hit = byEmail.get(email);
    if (!hit) {
      miss += 1;
      console.warn(`[msrs2-positives] missing on campaign: ${email}`);
      continue;
    }
    const categoryId = Number(row.category_id ?? 1);
    if (!apply) {
      ok += 1;
      continue;
    }
    try {
      await withRetry(
        () =>
          apiRequest(BASE, key, `campaigns/${campaignId}/leads/${hit.leadId}/category`, {
            method: "POST",
            body: { category_id: categoryId, pause_lead: false },
            retries: 0,
          }),
        `category ${email}`,
      );
      ok += 1;
      console.log(
        `[msrs2-positives] set ${email} → category_id=${categoryId}`,
      );
      await sleep(GAP_MS);
    } catch (error) {
      fail += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[msrs2-positives] FAIL ${email}: ${message}`);
      // Fallback: master-inbox update-category with map id
      if (hit.mapId) {
        try {
          await withRetry(
            () =>
              apiRequest(BASE, key, "master-inbox/update-category", {
                method: "PATCH",
                body: {
                  email_lead_map_id: hit.mapId,
                  category_id: categoryId,
                },
                retries: 0,
              }),
            `inbox-category ${email}`,
          );
          ok += 1;
          fail -= 1;
          console.log(
            `[msrs2-positives] inbox fallback set ${email} → ${categoryId}`,
          );
        } catch (e2) {
          console.warn(
            `[msrs2-positives] inbox fallback FAIL ${email}:`,
            e2 instanceof Error ? e2.message : e2,
          );
        }
      }
      await sleep(GAP_MS);
    }
  }

  console.log(
    `[msrs2-positives] done ok=${ok} miss=${miss} fail=${fail}`,
  );
}

main().catch((error) => {
  console.error("[msrs2-positives] failed", error);
  process.exit(1);
});
