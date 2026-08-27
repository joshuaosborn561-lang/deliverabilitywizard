/**
 * D144 — recreate deleted Nieto / MSRS / Positive campaigns from the
 * Supabase mirror dump in data/old-client-restore/.
 *
 * Smartlead DELETE is permanent. This creates NEW campaign ids, writes
 * sequences, optionally imports leads, and leaves every campaign PAUSED.
 * Never START (D40).
 *
 * Usage:
 *   npx tsx scripts/restore-old-clients.ts              # dry-run
 *   npx tsx scripts/restore-old-clients.ts --apply      # create + sequences + pause
 *   npx tsx scripts/restore-old-clients.ts --apply --leads
 *
 * Requires SMARTLEAD_API_KEY. Prefer `railway run -- npx tsx ...` after D144
 * is deployed so health cannot re-delete the restored names.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SmartleadClient } from "../src/clients/smartlead.js";
import { campaignIdFromCreate } from "../src/lib/podControlShell.js";
import { sleep } from "../src/lib/http.js";
import type { SmartleadSequence } from "../src/types/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data", "old-client-restore");
const WRITE_GAP_MS = 800;
const LEAD_BATCH = 350;

interface RestoreSequence extends Omit<SmartleadSequence, "id"> {
  id?: number;
  source?: string;
}

interface RestoreCampaign {
  oldId: number;
  name: string;
  priorStatus?: string;
  sequences: RestoreSequence[];
}

interface RestoreLead {
  smartlead_campaign_id: number;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
}

function parseArgs(argv: string[]) {
  return {
    apply: argv.includes("--apply"),
    leads: argv.includes("--leads"),
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

function loadCampaigns(): RestoreCampaign[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "campaigns.json"), "utf8"),
  ) as RestoreCampaign[];
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error("data/old-client-restore/campaigns.json is empty");
  }
  return raw;
}

function loadLeads(): RestoreLead[] {
  const file = path.join(DATA_DIR, "leads.json");
  if (!fs.existsSync(file)) {
    throw new Error(
      "data/old-client-restore/leads.json missing — export from Supabase first",
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as RestoreLead[];
}

function loadExistingMap(): Record<string, number> {
  const file = path.join(DATA_DIR, "restore-map.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, number>;
}

function saveMap(map: Record<string, number>) {
  fs.writeFileSync(
    path.join(DATA_DIR, "restore-map.json"),
    JSON.stringify(map, null, 2) + "\n",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.SMARTLEAD_API_KEY?.trim();
  if (!apiKey) throw new Error("SMARTLEAD_API_KEY is required");

  let campaigns = loadCampaigns();
  if (args.only?.length) {
    const want = new Set(args.only);
    campaigns = campaigns.filter((c) => want.has(c.oldId));
  }

  const smartlead = new SmartleadClient(apiKey);
  const existing = await smartlead.listCampaigns();
  const byName = new Map(
    existing.map((c) => [String(c.name ?? "").trim().toLowerCase(), c]),
  );
  const map = loadExistingMap();

  console.log(
    `[restore-old-clients] dryRun=${!args.apply} leads=${args.leads} campaigns=${campaigns.length}`,
  );

  for (const campaign of campaigns) {
    const key = String(campaign.oldId);
    const nameKey = campaign.name.trim().toLowerCase();
    let newId = map[key];
    const named = byName.get(nameKey);

    if (named) {
      newId = named.id;
      map[key] = newId;
      console.log(
        `[restore-old-clients] reuse #${newId} for old #${campaign.oldId} ${campaign.name}`,
      );
    } else if (newId) {
      // Stale map entries from a failed earlier pass — verify before reuse.
      try {
        const got = await smartlead.getCampaign(newId);
        if (!got || !(got as { id?: number }).id) {
          console.warn(
            `[restore-old-clients] map id #${newId} gone — recreating ${campaign.name}`,
          );
          delete map[key];
          newId = undefined as unknown as number;
          saveMap(map);
        }
      } catch {
        console.warn(
          `[restore-old-clients] map id #${newId} 404 — recreating ${campaign.name}`,
        );
        delete map[key];
        newId = undefined as unknown as number;
        saveMap(map);
      }
    }

    if (!newId) {
      if (!args.apply) {
        console.log(
          `[restore-old-clients] would create ${campaign.name} (${campaign.sequences.length} steps)`,
        );
        continue;
      }
      const raw = await smartlead.createCampaign(campaign.name);
      newId = campaignIdFromCreate(raw);
      if (newId == null) {
        throw new Error(`createCampaign returned no id for ${campaign.name}`);
      }
      map[key] = newId;
      byName.set(nameKey, { id: newId, name: campaign.name, status: "DRAFTED" });
      saveMap(map);
      console.log(
        `[restore-old-clients] created #${newId} for old #${campaign.oldId} ${campaign.name}`,
      );
      await sleep(WRITE_GAP_MS);
    }

    if (!args.apply) continue;

    if (campaign.sequences.length) {
      // New campaigns: Smartlead wants id:0 for brand-new steps (canaryShell /
      // podControlShell). A real id that does not exist 500s with
      // "Sequence N was not found".
      const sequences = campaign.sequences.map((step) => {
        const variant = step.seq_variants?.[0];
        const subject = ((variant?.subject ?? step.subject ?? "").trim()) || "follow up";
        const email_body =
          ((variant?.email_body ?? step.email_body ?? "").trim()) ||
          "<div>{{first_name}},</div>";
        const delay =
          step.seq_delay_details?.delay_in_days ??
          step.seq_delay_details?.delayInDays ??
          1;
        return {
          id: 0,
          seq_number: step.seq_number,
          seq_delay_details: { delay_in_days: delay, delayInDays: delay },
          subject,
          email_body,
          seq_variants: (step.seq_variants ?? []).map((v) => ({
            subject: (v.subject ?? subject) || "follow up",
            email_body: (v.email_body ?? email_body) || "<div>{{first_name}},</div>",
            variant_label: v.variant_label ?? "A",
          })),
        } as unknown as SmartleadSequence;
      });
      await smartlead.updateCampaignSequences(newId!, sequences);
      console.log(
        `[restore-old-clients] wrote ${sequences.length} sequences → #${newId}`,
      );
      await sleep(WRITE_GAP_MS);
    }

    const status = String(named?.status ?? "").toUpperCase();
    if (status !== "PAUSED") {
      await smartlead.updateCampaignStatus(newId!, "PAUSED");
      console.log(`[restore-old-clients] PAUSED #${newId}`);
      await sleep(WRITE_GAP_MS);
    }
  }

  saveMap(map);

  if (args.leads && args.apply) {
    const leads = loadLeads();
    for (const campaign of campaigns) {
      const newId = map[String(campaign.oldId)];
      if (!newId) continue;
      const rows = leads.filter(
        (l) =>
          l.smartlead_campaign_id === campaign.oldId &&
          typeof l.email === "string" &&
          l.email.includes("@"),
      );
      console.log(
        `[restore-old-clients] importing ${rows.length} leads → #${newId}`,
      );
      for (let i = 0; i < rows.length; i += LEAD_BATCH) {
        const batch = rows.slice(i, i + LEAD_BATCH).map((l) => ({
          email: l.email.trim(),
          first_name: l.first_name ?? undefined,
          last_name: l.last_name ?? undefined,
        }));
        const result = await smartlead.addLeadsToCampaign(newId, batch);
        console.log(
          `[restore-old-clients] leads batch ${i}-${i + batch.length} →`,
          {
            upload_count: result.upload_count,
            already_added_to_campaign: result.already_added_to_campaign,
            total_leads: result.total_leads,
          },
        );
        await sleep(WRITE_GAP_MS);
      }
    }
  } else if (args.leads && !args.apply) {
    const leads = loadLeads();
    for (const campaign of campaigns) {
      const n = leads.filter(
        (l) => l.smartlead_campaign_id === campaign.oldId,
      ).length;
      console.log(
        `[restore-old-clients] would import ${n} leads for old #${campaign.oldId}`,
      );
    }
  }

  console.log("[restore-old-clients] map", map);
  console.log(
    "[restore-old-clients] done — campaigns are PAUSED; do not START without Josh",
  );
}

main().catch((error) => {
  console.error("[restore-old-clients] failed", error);
  process.exit(1);
});
