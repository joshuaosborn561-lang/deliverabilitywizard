/**
 * Deferred generic-pool mailbox provisioning.
 *
 * Nameserver sync can take 3–4 hours after Porkbun NS update.
 * InboxKit mailbox orders then take another ~6–8 hours to process.
 *
 * This script REFUSES to buy until InboxKit reports nameservers ready
 * (unless --force). Use --wait to poll up to N hours.
 *
 * Usage:
 *   npx tsx scripts/provision-pool-mailboxes.ts --status
 *   npx tsx scripts/provision-pool-mailboxes.ts --wait 4
 *   npx tsx scripts/provision-pool-mailboxes.ts --buy
 *   npx tsx scripts/provision-pool-mailboxes.ts --buy --force   # skip NS gate (not recommended)
 *
 * Env: INBOXKIT_API_KEY, GENERIC_POOL_WORKSPACE_ID (or from data file)
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InboxKitClient } from "../src/clients/inboxkit.js";
import { sleep } from "../src/lib/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLAN_PATH = path.join(ROOT, "data/generic-pool-domains.json");
const OUT_PATH = path.join(ROOT, "data/generic-pool-mailbox-orders.json");

interface PoolPlan {
  workspaceId: string;
  workspaceName?: string;
  mailboxesPerDomain: number;
  domains: Array<{
    domain: string;
    parent: string;
    platform: "GOOGLE" | "MICROSOFT";
  }>;
}

const FIRST_NAMES = [
  "Marty",
  "Jo",
  "Alex",
  "Sam",
  "Riley",
  "Casey",
  "Jordan",
  "Taylor",
  "Morgan",
  "Quinn",
  "Avery",
  "Reese",
  "Parker",
  "Drew",
  "Blake",
  "Cameron",
  "Hayden",
  "Rowan",
  "Skyler",
  "Emerson",
];
const LAST_NAMES = [
  "Moen",
  "Shmo",
  "Hayes",
  "Brooks",
  "Coleman",
  "Reed",
  "Foster",
  "Bennett",
  "Griffin",
  "Palmer",
  "Walsh",
  "Nash",
  "Keller",
  "Boone",
  "Pratt",
  "Sloan",
  "Vance",
  "Hale",
  "Croft",
  "Lang",
];

function parseArgs(argv: string[]) {
  const flags = new Set<string>();
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--status") flags.add("status");
    else if (a === "--buy") flags.add("buy");
    else if (a === "--force") flags.add("force");
    else if (a === "--wait") {
      flags.add("wait");
      opts.waitHours = argv[++i] || "4";
    } else if (a === "--dry-run") flags.add("dry-run");
  }
  return { flags, opts };
}

function pickName(seed: number): {
  first_name: string;
  last_name: string;
  username: string;
} {
  const first = FIRST_NAMES[seed % FIRST_NAMES.length]!;
  const last = LAST_NAMES[Math.floor(seed / FIRST_NAMES.length) % LAST_NAMES.length]!;
  const username = `${first}${last}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  return { first_name: first, last_name: last, username };
}

async function loadPlan(): Promise<PoolPlan> {
  return JSON.parse(await readFile(PLAN_PATH, "utf8")) as PoolPlan;
}

async function checkNsStatus(
  ik: InboxKitClient,
  plan: PoolPlan,
): Promise<{
  total: number;
  ready: number;
  pending: Array<{ domain: string; ns: string; status: string }>;
  readyDomains: string[];
}> {
  const listed = await ik.listDomains(plan.workspaceId, { limit: 100 });
  const byName = new Map(
    listed.map((d) => [(d.name || d.domain || "").toLowerCase(), d]),
  );
  const pending: Array<{ domain: string; ns: string; status: string }> = [];
  const readyDomains: string[] = [];
  for (const row of plan.domains) {
    const d = byName.get(row.domain.toLowerCase());
    if (!d) {
      pending.push({
        domain: row.domain,
        ns: "missing",
        status: "not-in-workspace",
      });
      continue;
    }
    if (InboxKitClient.nameserversReady(d)) {
      readyDomains.push(row.domain);
    } else {
      pending.push({
        domain: row.domain,
        ns: String(d.nameserver_match_status ?? "unknown"),
        status: String(d.status ?? "unknown"),
      });
    }
  }
  return {
    total: plan.domains.length,
    ready: readyDomains.length,
    pending,
    readyDomains,
  };
}

async function main(): Promise<void> {
  const { flags, opts } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.INBOXKIT_API_KEY || "";
  if (!apiKey) {
    console.error("INBOXKIT_API_KEY is required");
    process.exit(1);
  }

  const plan = await loadPlan();
  const workspaceId =
    process.env.GENERIC_POOL_WORKSPACE_ID ||
    process.env.INBOXKIT_GENERIC_POOL_WORKSPACE_ID ||
    plan.workspaceId;
  plan.workspaceId = workspaceId;

  const ik = new InboxKitClient(apiKey, workspaceId);

  const printStatus = async () => {
    const st = await checkNsStatus(ik, plan);
    console.log(
      JSON.stringify(
        {
          workspaceId,
          ready: `${st.ready}/${st.total}`,
          pendingCount: st.pending.length,
          pendingSample: st.pending.slice(0, 8),
          note: "NS sync often takes 3–4h; mailbox processing another 6–8h after buy.",
        },
        null,
        2,
      ),
    );
    return st;
  };

  if (flags.has("status") && !flags.has("buy") && !flags.has("wait")) {
    await printStatus();
    return;
  }

  let status = await printStatus();

  if (flags.has("wait")) {
    const maxHours = Number(opts.waitHours || "4");
    const deadline = Date.now() + maxHours * 60 * 60 * 1000;
    console.log(
      `[provision] Waiting up to ${maxHours}h for NS sync (${status.ready}/${status.total} ready)…`,
    );
    while (status.pending.length > 0 && Date.now() < deadline) {
      await sleep(15 * 60 * 1000); // poll every 15 minutes
      status = await checkNsStatus(ik, plan);
      console.log(
        `[provision] ${new Date().toISOString()} ready ${status.ready}/${status.total}`,
      );
    }
  }

  if (!flags.has("buy")) {
    console.log("[provision] No --buy flag; status only. Exiting.");
    return;
  }

  if (status.pending.length > 0 && !flags.has("force")) {
    console.error(
      `[provision] Refusing to buy: ${status.pending.length} domain(s) still waiting on nameservers.`,
    );
    console.error(
      "Re-run later with --status, or --wait N, or --buy --force (not recommended).",
    );
    process.exit(2);
  }

  const perDomain = plan.mailboxesPerDomain || 3;
  const orders: unknown[] = [];
  let seed = 0;
  for (const row of plan.domains) {
    if (!flags.has("force") && !status.readyDomains.includes(row.domain)) {
      console.warn(`[provision] skip ${row.domain} (NS not ready)`);
      continue;
    }
    const mailboxes = [];
    for (let i = 0; i < perDomain; i++) {
      const person = pickName(seed++);
      mailboxes.push({
        ...person,
        platform: row.platform,
        domain_name: row.domain,
      });
    }

    if (flags.has("dry-run")) {
      console.log("[dry-run] would buy", mailboxes);
      orders.push({ domain: row.domain, dryRun: true, mailboxes });
      continue;
    }

    try {
      const idem = `pool-${row.domain}-${row.platform}-x${perDomain}-v1`;
      const result = await ik.buyMailboxes(mailboxes, {
        workspaceId,
        useWalletBalance: true,
        idempotencyKey: idem,
      });
      console.log(`[provision] ordered ${perDomain} on ${row.domain} (${row.platform})`);
      orders.push({ domain: row.domain, platform: row.platform, result });
      await sleep(1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[provision] buy failed ${row.domain}: ${message}`);
      orders.push({ domain: row.domain, error: message });
    }
  }

  await writeFile(OUT_PATH, JSON.stringify({ at: new Date().toISOString(), orders }, null, 2));
  console.log(`[provision] Wrote ${OUT_PATH}`);
  console.log(
    "[provision] Mailbox processing can take 6–8 hours. Do not re-order; check InboxKit later.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
