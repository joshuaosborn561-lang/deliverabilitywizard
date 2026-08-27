/**
 * D144 — after leads are imported, push Supabase lifecycle statuses onto
 * Smartlead leads so the lead list looks lived-in (COMPLETED / BOUNCED /
 * INTERESTED). Campaign analytics (sent / bounce totals) cannot be
 * backfilled after a Smartlead DELETE — those numbers stay in Supabase.
 *
 * Usage (after restore-old-clients --apply --leads):
 *   railway run -- npx tsx scripts/restore-old-client-statuses.ts --apply
 *   railway run -- npx tsx scripts/restore-old-client-statuses.ts --apply --only 3437329,3628940
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SmartleadClient } from "../src/clients/smartlead.js";
import { sleep } from "../src/lib/http.js";
import { ApiError } from "../src/lib/http.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data", "old-client-restore");
const GAP_MS = 350;

interface RestoreLead {
  smartlead_campaign_id: number;
  email: string;
  status?: string | null;
  category?: string | null;
}

function mapStatus(lead: RestoreLead): string | null {
  const category = String(lead.category ?? "").toLowerCase();
  if (category.includes("positive") || category === "interested") {
    return "INTERESTED";
  }
  if (category.includes("not interested")) return "NOT_INTERESTED";
  if (category.includes("do not contact")) return "DO_NOT_CONTACT";
  if (category.includes("bounce")) return "BOUNCED";
  if (category.includes("unsubscribe")) return "UNSUBSCRIBED";

  const status = String(lead.status ?? "").toUpperCase();
  if (status === "COMPLETED") return "COMPLETED";
  if (status === "INPROGRESS" || status === "IN_PROGRESS") return "IN_PROGRESS";
  if (status === "BLOCKED") return "DO_NOT_CONTACT";
  return null;
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
      console.warn(`[restore-statuses] ${label} ${status} — wait ${wait}ms`);
      await sleep(wait);
    }
  }
  return fn();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.SMARTLEAD_API_KEY?.trim();
  if (!apiKey) throw new Error("SMARTLEAD_API_KEY is required");
  const map = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "restore-map.json"), "utf8"),
  ) as Record<string, number>;
  const leads = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "leads.json"), "utf8"),
  ) as RestoreLead[];

  let oldIds = Object.keys(map).map(Number);
  if (args.only?.length) oldIds = oldIds.filter((id) => args.only!.includes(id));

  const smartlead = new SmartleadClient(apiKey);
  console.log(
    `[restore-statuses] dryRun=${!args.apply} campaigns=${oldIds.length}`,
  );

  for (const oldId of oldIds) {
    const campaignId = map[String(oldId)];
    if (!campaignId) continue;
    const rows = leads.filter((l) => l.smartlead_campaign_id === oldId);
    // Pull Smartlead lead ids by paging.
    const emailToId = new Map<string, number>();
    let offset = 0;
    for (;;) {
      const page = (await withRetry(
        () => smartlead.getCampaignLeads(campaignId, { limit: 100, offset }),
        `list #${campaignId}@${offset}`,
      )) as {
        data?: Array<{ id?: number; lead_id?: number; email?: string; lead?: { email?: string; id?: number } }>;
        total_leads?: number;
      };
      const data = Array.isArray(page?.data) ? page.data : [];
      for (const row of data) {
        const email = String(
          row.email ?? row.lead?.email ?? "",
        ).toLowerCase();
        const id = Number(row.lead_id ?? row.lead?.id ?? row.id);
        if (email && id > 0) emailToId.set(email, id);
      }
      offset += data.length;
      if (data.length < 100) break;
      await sleep(GAP_MS);
    }
    console.log(
      `[restore-statuses] #${campaignId} old #${oldId}: ${emailToId.size} leads listed, ${rows.length} in dump`,
    );

    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const want = mapStatus(row);
      if (!want || want === "NOT_CONTACTED") {
        skipped += 1;
        continue;
      }
      const leadId = emailToId.get(String(row.email).toLowerCase());
      if (!leadId) {
        skipped += 1;
        continue;
      }
      if (!args.apply) {
        updated += 1;
        continue;
      }
      try {
        await withRetry(
          () => smartlead.updateLeadStatus(campaignId, leadId, want),
          `status #${campaignId}/${leadId}`,
        );
        updated += 1;
        if (updated % 50 === 0) {
          console.log(
            `[restore-statuses] #${campaignId} updated=${updated}`,
          );
        }
        await sleep(GAP_MS);
      } catch (error) {
        console.warn(
          `[restore-statuses] #${campaignId} ${row.email} ${want}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    console.log(
      `[restore-statuses] #${campaignId} done updated=${updated} skipped=${skipped}`,
    );
  }
}

main().catch((error) => {
  console.error("[restore-statuses] failed", error);
  process.exit(1);
});
