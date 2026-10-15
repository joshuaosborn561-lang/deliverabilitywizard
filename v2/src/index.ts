import cron from "node-cron";
import { createApi } from "./api.js";
import { loadConfig, writesAllowed } from "./config.js";
import { livingFleetEmails } from "./lib/fleet.js";
import { hasTag } from "./lib/staffable.js";
import { SmartleadReader } from "./clients/smartlead.js";
import { SmartDeliveryReader } from "./clients/smartdelivery.js";
import { InboxkitReader } from "./clients/inboxkit.js";
import { runInboxkitSweep } from "./jobs/inboxkit.js";
import { runIsolationTick } from "./jobs/isolation.js";
import { runStaffTick } from "./jobs/staff.js";
import { WriteGate } from "./shadow.js";
import { MemoryStore, PostgresStore, type V2Store } from "./store.js";

const config = loadConfig();
const store: V2Store = config.databaseUrl
  ? new PostgresStore(config.databaseUrl)
  : new MemoryStore();
const gate = new WriteGate(config, store);

if (writesAllowed(config)) {
  console.warn(
    "[v2] WRITE_ENABLED=true and SHADOW=false — Smartlead/InboxKit/Slack writes are LIVE",
  );
} else {
  console.log(
    `[v2] shadow mode on (WRITE_ENABLED=${config.writeEnabled}, SHADOW=${config.shadow}). Zero writes.`,
  );
}

await store.migrate();

const smartlead = config.smartleadApiKey ? new SmartleadReader(config.smartleadApiKey) : null;
const smartDelivery = config.smartDeliveryApiKey
  ? new SmartDeliveryReader(config.smartDeliveryApiKey)
  : null;
const inboxkit = config.inboxkitApiKey ? new InboxkitReader(config.inboxkitApiKey) : null;

async function fetchBook() {
  if (!smartlead) throw new Error("SMARTLEAD_API_KEY missing");
  const [campaigns, accounts] = await Promise.all([
    smartlead.listCampaigns(),
    smartlead.listAccounts(),
  ]);
  const book = {
    fetchedAt: new Date().toISOString(),
    campaigns,
    accounts,
  };
  await store.saveInventory(book);
  return book;
}

function fleetFromBook(accounts: { email: string; tags: string[] }[]): string[] {
  const tagged = accounts
    .filter((a) => hasTag(a.tags, "CANARY"))
    .map((a) => a.email);
  return livingFleetEmails(tagged, config.canaryFleetEmails);
}

async function staffPass(): Promise<void> {
  const stage = "staff";
  try {
    const book = await fetchBook();
    const result = await runStaffTick({
      book,
      fleetEmails: fleetFromBook(book.accounts),
      gate,
      store,
      config,
    });
    const keep = (await store.listFindings()).filter((f) => ISOLATION_FINDING_KINDS.has(f.kind));
    await store.replaceFindings([...keep, ...result.findings]);
    await store.stampOk(stage);
    console.log(
      `[v2] staff ok findings=${result.findings.length} intended=${result.intended.length}`,
    );
  } catch (error) {
    await store.stampError(stage, String(error));
    console.error("[v2] staff failed", error);
  }
}

async function isolationPass(): Promise<void> {
  const stage = "isolation";
  try {
    if (!smartDelivery) throw new Error("SMARTDELIVERY_API_KEY missing");
    const book = (await store.loadInventory()) ?? (await fetchBook());
    const tests = await smartDelivery.listTests();
    const result = await runIsolationTick({
      book,
      tests,
      fleetEmails: fleetFromBook(book.accounts),
      gate,
      store,
      config,
    });
    const keep = (await store.listFindings()).filter((f) => !ISOLATION_FINDING_KINDS.has(f.kind));
    await store.replaceFindings([...keep, ...result.findings]);
    await store.stampOk(stage);
    console.log(
      `[v2] isolation ok scored=${result.scored} queued=${result.queued} evaluated=${result.evaluated} overdue=${result.overdue}`,
    );
  } catch (error) {
    await store.stampError(stage, String(error));
    console.error("[v2] isolation failed", error);
  }
}

async function inboxkitPass(): Promise<void> {
  const stage = "inboxkit";
  try {
    if (!inboxkit) {
      await store.stampOk(stage);
      return;
    }
    const book = await store.loadInventory();
    const seats = await inboxkit.listMailboxes();
    const result = await runInboxkitSweep({
      seats,
      accounts: book?.accounts ?? [],
      gate,
    });
    await store.stampOk(stage);
    console.log(`[v2] inboxkit sweep intendedDeletes=${result.deleted}`);
  } catch (error) {
    await store.stampError(stage, String(error));
    console.error("[v2] inboxkit failed", error);
  }
}

const ISOLATION_FINDING_KINDS = new Set([
  "ugly_without_isolation",
  "isolation_deadline",
  "missing_canary",
  "duplicate_canary_test",
  "no_placement_test",
]);

const runHttp = config.role === "api" || config.role === "all";
const runStaff = config.role === "staff" || config.role === "all";
const runIsolation = config.role === "isolation" || config.role === "all";

if (runHttp) {
  const app = createApi({ config, store });
  app.listen(config.port, () => {
    console.log(`[v2] api listening :${config.port} role=${config.role}`);
  });
}

if (runStaff) {
  cron.schedule("*/15 * * * *", () => {
    void staffPass();
  });
  cron.schedule("16 8 * * 1-5", () => {
    void inboxkitPass();
  }, { timezone: "America/Chicago" });
}

if (runIsolation) {
  cron.schedule("*/15 * * * *", () => {
    void isolationPass();
  });
}

process.on("SIGTERM", () => process.exit(0));
