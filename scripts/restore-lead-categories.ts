/**
 * D144 — re-apply Supabase lead categories onto restored Smartlead
 * campaigns via POST .../leads/{leadId}/category. That is what moves
 * campaign_lead_stats.interested / reply categories in the UI.
 *
 *   railway run -- npx tsx scripts/restore-lead-categories.ts --apply
 *   railway run -- npx tsx scripts/restore-lead-categories.ts --apply --only 3628940,3563069
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiRequest, ApiError, sleep } from "../src/lib/http.js";
import { SmartleadClient } from "../src/clients/smartlead.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data", "old-client-restore");
const BASE = "https://server.smartlead.ai/api/v1/";
const GAP_MS = 350;

const NAME_TO_ID: Record<string, number> = {
  interested: 1,
  "meeting request": 2,
  "not interested": 3,
  "do not contact": 4,
  "information request": 5,
  "out of office": 6,
  "wrong person": 7,
  "uncategorizable by ai": 8,
  "sender originated bounce": 9,
  "positive reply": 131482,
};

interface LeadRow {
  smartlead_campaign_id: number;
  email: string;
  category?: string | null;
  category_id?: number | null;
}

function categoryIdFor(row: LeadRow): number | null {
  if (row.category_id != null && Number(row.category_id) > 0) {
    return Number(row.category_id);
  }
  const name = String(row.category ?? "")
    .trim()
    .toLowerCase();
  return NAME_TO_ID[name] ?? null;
}

function parseArgs(argv: string[]) {
  return {
    apply: argv.includes("--apply"),
    only: (() => {
      const idx = argv.indexOf("--only");
      if (idx < 0) return null as number[] | null;
      return String(argv[idx + 1] ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    })(),
  };
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      if (status !== 429 && status < 500) throw error;
      const wait = Math.min(90_000, 5_000 * 2 ** attempt);
      console.warn(`[restore-categories] ${label} ${status} — wait ${wait}ms`);
      await sleep(wait);
    }
  }
  return fn();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.SMARTLEAD_API_KEY?.trim();
  if (!key) throw new Error("SMARTLEAD_API_KEY required");

  const map = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "restore-map.json"), "utf8"),
  ) as Record<string, number>;
  const leads = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "leads.json"), "utf8"),
  ) as LeadRow[];

  let oldIds = [
    ...new Set(
      leads
        .filter((l) => categoryIdFor(l) != null)
        .map((l) => l.smartlead_campaign_id),
    ),
  ];
  if (args.only?.length) {
    oldIds = oldIds.filter((id) => args.only!.includes(id));
  }

  const smartlead = new SmartleadClient(key);
  console.log(
    `[restore-categories] apply=${args.apply} campaigns=${oldIds.length}`,
  );

  for (const oldId of oldIds) {
    const campaignId = map[String(oldId)];
    if (!campaignId) {
      console.warn(`[restore-categories] no map for old #${oldId}`);
      continue;
    }
    const rows = leads.filter(
      (l) => l.smartlead_campaign_id === oldId && categoryIdFor(l) != null,
    );

    const byEmail = new Map<string, number>();
    let offset = 0;
    for (;;) {
      const page = (await withRetry(
        () => smartlead.getCampaignLeads(campaignId, { limit: 100, offset }),
        `list #${campaignId}@${offset}`,
      )) as {
        data?: Array<{ lead?: { id?: number; email?: string } }>;
      };
      const data = Array.isArray(page.data) ? page.data : [];
      for (const row of data) {
        const email = String(row.lead?.email ?? "")
          .trim()
          .toLowerCase();
        const leadId = Number(row.lead?.id);
        if (email && leadId > 0) byEmail.set(email, leadId);
      }
      offset += data.length;
      if (data.length < 100) break;
      await sleep(GAP_MS);
    }

    console.log(
      `[restore-categories] #${campaignId} old #${oldId}: dump=${rows.length} listed=${byEmail.size}`,
    );

    let ok = 0;
    let miss = 0;
    let fail = 0;
    for (const row of rows) {
      const email = String(row.email).trim().toLowerCase();
      const leadId = byEmail.get(email);
      const categoryId = categoryIdFor(row);
      if (!leadId || categoryId == null) {
        miss += 1;
        continue;
      }
      if (!args.apply) {
        ok += 1;
        continue;
      }
      try {
        await withRetry(
          () =>
            apiRequest(
              BASE,
              key,
              `campaigns/${campaignId}/leads/${leadId}/category`,
              {
                method: "POST",
                body: { category_id: categoryId, pause_lead: false },
                retries: 0,
              },
            ),
          `cat #${campaignId}/${leadId}`,
        );
        ok += 1;
        if (ok % 25 === 0) {
          console.log(`[restore-categories] #${campaignId} ok=${ok}`);
        }
        await sleep(GAP_MS);
      } catch (error) {
        fail += 1;
        console.warn(
          `[restore-categories] FAIL ${email} → ${categoryId}:`,
          error instanceof Error ? error.message : error,
        );
        await sleep(GAP_MS);
      }
    }
    console.log(
      `[restore-categories] #${campaignId} done ok=${ok} miss=${miss} fail=${fail}`,
    );
  }
}

main().catch((error) => {
  console.error("[restore-categories] failed", error);
  process.exit(1);
});
