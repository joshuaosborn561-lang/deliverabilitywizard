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
import { SharedSmartleadLimiter } from "./lib/limiter.js";
import { inStaffingHours } from "./lib/quietHours.js";
import { loadOrRefreshInventory } from "./lib/inventory.js";
import { formatSecretScrubLog, safeErrorText } from "./lib/redact.js";
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
console.log(formatSecretScrubLog(await store.countUnredactedSecretRows()));

const limiter = new SharedSmartleadLimiter(store);
const smartlead = config.smartleadApiKey
  ? new SmartleadReader(config.smartleadApiKey, (fn) => limiter.schedule(fn))
  : null;
const smartDelivery = config.smartDeliveryApiKey
  ? new SmartDeliveryReader(config.smartDeliveryApiKey, (fn) => limiter.schedule(fn))
  : null;
const inboxkit = config.inboxkitApiKey ? new InboxkitReader(config.inboxkitApiKey) : null;

async function fetchBook() {
  if (!smartlead) throw new Error("SMARTLEAD_API_KEY missing");
  const campaigns = await smartlead.listCampaigns();
  const accounts = await smartlead.listAccounts();
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
    if (!inStaffingHours()) {
      await store.stampOk(stage);
      console.log("[v2] staff skip — quiet hours (weekdays 6am–8pm CT)");
      return;
    }
    const loaded = await loadOrRefreshInventory(store, fetchBook);
    const book = loaded.book;
    if (!loaded.refreshed) {
      console.log(`[v2] staff inventory cache hit age_ms=${loaded.ageMs}`);
    }
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
    await store.stampError(stage, safeErrorText(error));
    console.error("[v2] staff failed", safeErrorText(error));
  }
}

async function isolationPass(): Promise<void> {
  const stage = "isolation";
  try {
    if (!inStaffingHours()) {
      await store.stampOk(stage);
      console.log("[v2] isolation skip — quiet hours (weekdays 6am–8pm CT)");
      return;
    }
    if (!smartDelivery) throw new Error("SMARTDELIVERY_API_KEY missing");
    const book = (await store.loadInventory()) ?? (await fetchBook());
    const listed = await smartDelivery.listTests();
    const tests = await smartDelivery.hydrateSenders(listed);
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
    await store.stampError(stage, safeErrorText(error));
    console.error("[v2] isolation failed", safeErrorText(error));
  }
}

async function inboxkitPass(): Promise<void> {
  const stage = "inboxkit";
  try {
    if (!inStaffingHours()) {
      await store.stampOk(stage);
      console.log("[v2] inboxkit skip — quiet hours (weekdays 6am–8pm CT)");
      return;
    }
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
    await store.stampError(stage, safeErrorText(error));
    console.error("[v2] inboxkit failed", safeErrorText(error));
  }
}

const ISOLATION_FINDING_KINDS = new Set([
  "ugly_without_isolation",
  "isolation_deadline",
  "missing_canary",
  "duplicate_canary_test",
  "no_placement_test",
  "merge_tag_blank",
  "missing_signature_tag",
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
  cron.schedule(
    "*/15 * * * *",
    () => {
      void staffPass();
    },
    { timezone: "America/Chicago" },
  );
  cron.schedule(
    "16 8 * * 1-5",
    () => {
      void inboxkitPass();
    },
    { timezone: "America/Chicago" },
  );
}

if (runIsolation) {
  cron.schedule(
    "*/15 * * * *",
    () => {
      void isolationPass();
    },
    { timezone: "America/Chicago" },
  );
}

process.on("SIGTERM", () => process.exit(0));
