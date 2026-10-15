import cron from "node-cron";
import { createApi } from "./api.js";
import { loadConfig, writesAllowed } from "./config.js";
import { livingFleetEmails } from "./lib/fleet.js";
import {
  applyCampaignMembers,
  campaignsMissingMembers,
  loadOrRefreshInventory,
} from "./lib/inventory.js";
import { prioritizeTestsToHydrate } from "./lib/isolation.js";
import { isPocEngagementClient, shouldStaffPocCampaign } from "./lib/poc.js";
import { inStaffingHours } from "./lib/quietHours.js";
import { formatSecretScrubLog, safeErrorText } from "./lib/redact.js";
import { countIntendedKind, countKind, formatStageOkLog } from "./lib/stageLog.js";
import { hasTag, isActiveStatus } from "./lib/staffable.js";
import { SmartleadReader } from "./clients/smartlead.js";
import { SmartDeliveryReader } from "./clients/smartdelivery.js";
import { InboxkitReader } from "./clients/inboxkit.js";
import { runInboxkitSweep } from "./jobs/inboxkit.js";
import { runIsolationTick } from "./jobs/isolation.js";
import { runStaffTick } from "./jobs/staff.js";
import { SharedSmartleadLimiter } from "./lib/limiter.js";
import { WriteGate } from "./shadow.js";
import { MemoryStore, PostgresStore, type V2Store } from "./store.js";
import type { SequenceSample } from "./types.js";

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
  let accounts = await smartlead.listAccounts();
  const living = campaigns.filter(
    (campaign) =>
      isActiveStatus(campaign.status) ||
      (isPocEngagementClient({ clientId: campaign.clientId, name: campaign.name }) &&
        shouldStaffPocCampaign(campaign)),
  );
  for (const campaign of campaignsMissingMembers(living, accounts)) {
    const members = await smartlead.listCampaignAccounts(campaign.id);
    accounts = applyCampaignMembers(accounts, campaign.id, members);
  }
  const book = {
    fetchedAt: new Date().toISOString(),
    campaigns,
    accounts,
  };
  await store.saveInventory(book);
  return book;
}

async function loadSequences(campaigns: { id: number; status: string }[]) {
  if (!smartlead) return [];
  const out: SequenceSample[] = [];
  for (const campaign of campaigns.filter((c) => isActiveStatus(c.status))) {
    try {
      out.push(...(await smartlead.listSequences(campaign.id)));
    } catch (error) {
      console.error(`[v2] sequences failed campaign=${campaign.id}`, safeErrorText(error));
    }
  }
  return out;
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
    const sequences = await loadSequences(book.campaigns);
    const result = await runStaffTick({
      book,
      fleetEmails: fleetFromBook(book.accounts),
      gate,
      store,
      config,
      sequences,
    });
    const keep = (await store.listFindings()).filter((f) => ISOLATION_FINDING_KINDS.has(f.kind));
    await store.replaceFindings([...keep, ...result.findings]);
    await store.stampOk(stage);
    console.log(
      formatStageOkLog("staff", {
        findings: result.findings.length,
        understaffed: countKind(result.findings, "understaffed"),
        esp_mix: countKind(result.findings, "esp_mix"),
        generic_idle: countKind(result.findings, "generic_idle"),
        intended: result.intended.length,
        attach: countIntendedKind(result.intended, "attach"),
      }),
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
    const ranked = prioritizeTestsToHydrate(listed, book.campaigns);
    const withSenders = await smartDelivery.hydrateSenders(ranked);
    const tests = await smartDelivery.hydrateProviderSplits(withSenders);
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
      formatStageOkLog("isolation", {
        scored: result.scored,
        ugly: countKind(result.findings, "ugly_without_isolation"),
        below_launch_bar: countKind(result.findings, "below_launch_bar"),
        queued: result.queued,
        evaluated: result.evaluated,
        overdue: result.overdue,
        word_hunts: result.wordHunts,
      }),
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
      console.log(formatStageOkLog("inboxkit", { intendedDeletes: 0, skipped: "no_key" }));
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
    console.log(formatStageOkLog("inboxkit", { intendedDeletes: result.deleted }));
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
  "below_launch_bar",
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
