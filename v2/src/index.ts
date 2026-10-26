import { clientMicrosoftShares } from "./lib/inboxkitShare.js";
import type { SlimAccount as SlimAccountForShare } from "./types.js";
import cron from "node-cron";
import { createApi, createHealthApp } from "./api.js";
import { loadConfig, writesAllowed } from "./config.js";
import {
  V2_ISOLATION_PROVIDER_HYDRATE_CAP,
  V2_ISOLATION_SENDER_HYDRATE_CAP,
  V2_ISOLATION_TICK_TIMEOUT_MS,
  V2_RATE_SLOT_TTL_MS,
  V2_STAFF_MEMBER_HYDRATE_CAP,
  V2_STAFF_SEQUENCE_CAP,
  V2_STAFF_TICK_TIMEOUT_MS,
} from "./canon/constants.js";
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
import {
  formatProgressLog,
  formatSkipLog,
  TICK_INTERVAL_MS,
  tickSkipReason,
} from "./lib/tickGate.js";
import {
  isAbortError,
  isTickTimeoutError,
  startTick,
  TickTimeoutError,
  withTickDeadline,
  type TickHandle,
  budgetSignal,
  ISOLATION_BUDGET,
} from "./lib/tickClock.js";
import { hasTag, isActiveStatus } from "./lib/staffable.js";
import { SmartleadReader } from "./clients/smartlead.js";
import { SmartDeliveryReader } from "./clients/smartdelivery.js";
import { InboxkitReader } from "./clients/inboxkit.js";
import { runInboxkitSweep } from "./jobs/inboxkit.js";
import { runIsolationTick } from "./jobs/isolation.js";
import { runStaffTick } from "./jobs/staff.js";
import { retryOn429, SharedSmartleadLimiter } from "./lib/limiter.js";
import { WriteGate } from "./shadow.js";
import { MemoryStore, PostgresStore, type V2Store } from "./store.js";
import type { SequenceSample, SlimClient, SpamTest } from "./types.js";

const config = loadConfig();
const store: V2Store = config.databaseUrl
  ? new PostgresStore(config.databaseUrl)
  : new MemoryStore();
const gate = new WriteGate(config, store);
const boot = { starting: true };

if (writesAllowed(config)) {
  console.warn(
    "[v2] WRITE_ENABLED=true and SHADOW=false — Smartlead/InboxKit/Slack writes are LIVE",
  );
} else {
  console.log(
    `[v2] shadow mode on (WRITE_ENABLED=${config.writeEnabled}, SHADOW=${config.shadow}). Zero writes.`,
  );
}

const runStaff = config.role === "staff" || config.role === "all";
const runIsolation = config.role === "isolation" || config.role === "all";
const runFullApi = config.role === "api" || config.role === "all";

const http = runFullApi
  ? createApi({ config, store, boot })
  : createHealthApp({ config, store, boot });
http.listen(config.port, () => {
  console.log(
    `[v2] ${runFullApi ? "api" : "health-only"} listening :${config.port} role=${config.role}`,
  );
});

await store.migrate();
console.log(formatSecretScrubLog(await store.countUnredactedSecretRows()));
const staleLeases = await store.expireStaleTickLeases(V2_STAFF_TICK_TIMEOUT_MS);
await store.expireStaleRateSlots(V2_RATE_SLOT_TTL_MS);
if (runStaff) await store.releaseTickLease("staff");
if (runIsolation) await store.releaseTickLease("isolation");
console.log(`[v2] boot cleared stale tick leases=${staleLeases}`);
boot.starting = false;

const limiter = new SharedSmartleadLimiter(store);
const smartlead = config.smartleadApiKey
  ? new SmartleadReader(config.smartleadApiKey, (fn, signal) => limiter.schedule(fn, signal))
  : null;
const smartDelivery = config.smartDeliveryApiKey
  ? new SmartDeliveryReader(config.smartDeliveryApiKey, (fn, signal) => retryOn429(fn, signal))
  : null;
const inboxkit = config.inboxkitApiKey ? new InboxkitReader(config.inboxkitApiKey, config.inboxkitWorkspaceId || undefined) : null;

function progress(stage: string, tick: TickHandle, step: string, extra?: Record<string, string | number | boolean | null>) {
  tick.step(step);
  console.log(formatProgressLog(stage, step, { elapsed_ms: tick.elapsedMs(), ...extra }));
}

async function fetchBook(tick: TickHandle) {
  if (!smartlead) throw new Error("SMARTLEAD_API_KEY missing");
  let campaigns: Awaited<ReturnType<SmartleadReader["listCampaigns"]>> = [];
  let accounts: Awaited<ReturnType<SmartleadReader["listAccounts"]>> = [];
  let clients: SlimClient[] = [];
  let hydrated = 0;
  try {
    progress("staff", tick, "list_clients");
    try {
      clients = await smartlead.listClients(tick.signal);
    } catch (error) {
      if (isTickTimeoutError(error) || tick.signal.aborted) throw error;
      console.error("[v2] list_clients failed; signature checks skip brand-less seats", safeErrorText(error));
    }
    progress("staff", tick, "list_campaigns");
    campaigns = await smartlead.listCampaigns(tick.signal);
    progress("staff", tick, "list_accounts", { campaigns: campaigns.length });
    accounts = await smartlead.listAccounts({
      signal: tick.signal,
      onProgress: (info) =>
        progress("staff", tick, "list_accounts", {
          page: info.page ?? 0,
          truncated: info.truncated ?? false,
        }),
    });
    const living = campaigns.filter(
      (campaign) =>
        isActiveStatus(campaign.status) ||
        (isPocEngagementClient({ clientId: campaign.clientId, name: campaign.name }) &&
          shouldStaffPocCampaign(campaign)),
    );
    const missing = campaignsMissingMembers(living, accounts).slice(0, V2_STAFF_MEMBER_HYDRATE_CAP);
    for (const campaign of missing) {
      hydrated += 1;
      progress("staff", tick, "hydrate_members", {
        n: hydrated,
        of: missing.length,
        campaign: campaign.id,
      });
      const members = await smartlead.listCampaignAccounts(campaign.id, tick.signal);
      accounts = applyCampaignMembers(accounts, campaign.id, members);
    }
  } finally {
    if (campaigns.length || accounts.length) {
      await store.saveInventory({
        fetchedAt: new Date().toISOString(),
        campaigns,
        accounts,
        clients,
      });
      progress("staff", tick, "inventory_saved", {
        campaigns: campaigns.length,
        accounts: accounts.length,
        hydrated,
      });
    }
  }
  if (tick.signal.aborted && !campaigns.length) tick.throwIfAborted();
  return {
    fetchedAt: new Date().toISOString(),
    campaigns,
    accounts,
    clients,
  };
}

/** D303 — InboxKit seats cached 1h in-process; shares computed per tick. */
let inboxkitSeatCache: { at: number; seats: Awaited<ReturnType<InboxkitReader["listMailboxes"]>> } | null = null;
async function loadInboxkitShares(accounts: SlimAccountForShare[]): Promise<Map<number, number> | undefined> {
  if (!inboxkit) return undefined;
  try {
    if (!inboxkitSeatCache || Date.now() - inboxkitSeatCache.at > 60 * 60 * 1000) {
      inboxkitSeatCache = { at: Date.now(), seats: await inboxkit.listMailboxes() };
    }
    return clientMicrosoftShares(inboxkitSeatCache.seats, accounts);
  } catch (error) {
    console.error("[v2] inboxkit shares failed (1/3 floor fallback)", safeErrorText(error));
    return undefined;
  }
}

async function loadSequences(
  campaigns: { id: number; status: string }[],
  tick: TickHandle,
) {
  if (!smartlead) return [];
  const out: SequenceSample[] = [];
  const active = campaigns.filter((c) => isActiveStatus(c.status)).slice(0, V2_STAFF_SEQUENCE_CAP);
  let n = 0;
  for (const campaign of active) {
    n += 1;
    progress("staff", tick, "sequences", { n, of: active.length, campaign: campaign.id });
    try {
      out.push(...(await smartlead.listSequences(campaign.id, tick.signal)));
    } catch (error) {
      if (isTickTimeoutError(error) || tick.signal.aborted) throw error;
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

const ISOLATION_FINDING_KINDS = new Set([
  "ugly_without_isolation",
  "isolation_deadline",
  "missing_canary",
  "duplicate_canary_test",
  "no_placement_test",
  "below_launch_bar",
]);

async function guardedPass(
  stage: "staff" | "isolation" | "inboxkit",
  timeoutMs: number,
  skip: ReturnType<typeof tickSkipReason>,
  work: (tick: TickHandle) => Promise<void>,
): Promise<void> {
  if (skip) {
    console.log(formatSkipLog(stage, skip));
    if (skip !== "in_flight") await store.stampOk(stage, new Date(), skip);
    return;
  }
  const lease = await store.acquireTickLease(stage, timeoutMs);
  if (!lease.acquired) {
    console.log(formatSkipLog(stage, "in_flight", { lease: "held" }));
    return;
  }
  const tick = startTick(timeoutMs);
  try {
    progress(stage, tick, "start", { timeout_ms: timeoutMs });
    await withTickDeadline(tick, work(tick));
    await store.stampOk(stage);
  } catch (error) {
    const hungIn = tick.hungIn;
    if (isTickTimeoutError(error) || tick.signal.aborted) {
      const timeout = error instanceof TickTimeoutError ? error : new TickTimeoutError(hungIn, tick.elapsedMs());
      console.log(
        formatSkipLog(stage, "timeout", { hung_in: timeout.hungIn, elapsed_ms: timeout.elapsedMs }),
      );
      await store.stampError(stage, `timeout hung_in=${timeout.hungIn}`);
    } else {
      await store.stampError(stage, safeErrorText(error));
      console.error(`[v2] ${stage} failed`, safeErrorText(error));
    }
  } finally {
    tick.dispose();
    await store.releaseTickLease(stage);
  }
}

async function staffPass(): Promise<void> {
  await guardedPass(
    "staff",
    V2_STAFF_TICK_TIMEOUT_MS,
    tickSkipReason({
      quietHours: !inStaffingHours(),
      missingKey: smartlead ? null : "smartlead",
    }),
    async (tick) => {
      const loaded = await loadOrRefreshInventory(store, () => fetchBook(tick));
      const book = loaded.book;
      if (!loaded.refreshed) {
        progress("staff", tick, "inventory_cache", { age_ms: loaded.ageMs ?? 0 });
      }
      const sequences = await loadSequences(book.campaigns, tick);
      progress("staff", tick, "staff_tick", { sequences: sequences.length });
      const inboxkitShares = await loadInboxkitShares(book.accounts);
      const result = await runStaffTick({
        book,
        fleetEmails: fleetFromBook(book.accounts),
        gate,
        store,
        config,
        sequences,
        inboxkitShares,
      });
      await store.replaceFindingsInScope({ except: [...ISOLATION_FINDING_KINDS] }, result.findings);
      console.log(
        formatStageOkLog("staff", {
          findings: result.findings.length,
          understaffed: countKind(result.findings, "understaffed"),
          esp_mix: countKind(result.findings, "esp_mix"),
          generic_idle: countKind(result.findings, "generic_idle"),
          esp_matching: countKind(result.findings, "esp_matching"),
          plain_text: countKind(result.findings, "plain_text"),
          send_window: countKind(result.findings, "send_window"),
          intended: result.intended.length,
          attach: countIntendedKind(result.intended, "attach"),
          elapsed_ms: tick.elapsedMs(),
        }),
      );
    },
  );
}

async function isolationPass(): Promise<void> {
  await guardedPass(
    "isolation",
    V2_ISOLATION_TICK_TIMEOUT_MS,
    tickSkipReason({
      quietHours: !inStaffingHours(),
      missingKey: smartDelivery ? null : "smartdelivery",
    }),
    async (tick) => {
      progress("isolation", tick, "load_inventory");
      const inventory = await store.loadInventory();
      if (!inventory || inventory.campaigns.length === 0) {
        console.log(formatSkipLog("isolation", "inventory_unready"));
        return;
      }
      let tests: SpamTest[] = [];
      // D298: each SmartDelivery phase gets a slice of the tick, so a slow
      // providerwise report can no longer eat the whole budget (0 scored).
      const until = (frac: number) =>
        budgetSignal(tick.signal, frac * V2_ISOLATION_TICK_TIMEOUT_MS - tick.elapsedMs());
      const listBudget = until(ISOLATION_BUDGET.listTests);
      try {
        progress("isolation", tick, "list_tests", { campaigns: inventory.campaigns.length });
        tests = await smartDelivery!.listTests({
          signal: listBudget.signal,
          onProgress: (info) => progress("isolation", tick, "list_tests", { page: info.page }),
        });
      } catch (error) {
        if (tick.signal.aborted || (!isAbortError(error) && !isTickTimeoutError(error))) throw error;
        if (!tests.length) throw error;
      } finally {
        listBudget.dispose();
      }
      const ranked = prioritizeTestsToHydrate(tests, inventory.campaigns);
      progress("isolation", tick, "hydrate_senders", { listed: tests.length });
      const senderBudget = until(ISOLATION_BUDGET.hydrateSenders);
      try {
        tests = await smartDelivery!.hydrateSenders(
          ranked,
          V2_ISOLATION_SENDER_HYDRATE_CAP,
          senderBudget.signal,
          (info) => progress("isolation", tick, "hydrate_senders", { n: info.n, id: info.id }),
        );
      } finally {
        senderBudget.dispose();
      }
      progress("isolation", tick, "hydrate_providers");
      const providerBudget = until(ISOLATION_BUDGET.hydrateProviders);
      try {
        tests = await smartDelivery!.hydrateProviderSplits(
          tests,
          V2_ISOLATION_PROVIDER_HYDRATE_CAP,
          providerBudget.signal,
          (info) => progress("isolation", tick, "hydrate_providers", { n: info.n, id: info.id }),
        );
      } finally {
        providerBudget.dispose();
      }
      tick.throwIfAborted();
      console.log(
        formatProgressLog("isolation", "isolation_tick", {
          tests: tests.length,
          elapsed_ms: tick.elapsedMs(),
        }),
      );
      // D303 — variant ids for per-variant test intents (capped like staff).
      const isolationSequences = await loadSequences(inventory.campaigns, tick).catch(() => []);
      const result = await runIsolationTick({
        book: inventory,
        tests,
        sequences: isolationSequences,
        fleetEmails: fleetFromBook(inventory.accounts),
        gate,
        store,
        config,
        signal: tick.signal.aborted ? undefined : tick.signal,
      });
      if (tick.signal.aborted && result.scored === 0) {
        throw new TickTimeoutError(tick.hungIn, tick.elapsedMs());
      }
      await store.replaceFindingsInScope({ only: [...ISOLATION_FINDING_KINDS] }, result.findings);
      console.log(
        formatStageOkLog("isolation", {
          scored: result.scored,
          ugly: countKind(result.findings, "ugly_without_isolation"),
          below_launch_bar: countKind(result.findings, "below_launch_bar"),
          queued: result.queued,
          evaluated: result.evaluated,
          overdue: result.overdue,
          word_hunts: result.wordHunts,
          elapsed_ms: tick.elapsedMs(),
        }),
      );
    },
  );
}

async function inboxkitPass(): Promise<void> {
  await guardedPass(
    "inboxkit",
    V2_STAFF_TICK_TIMEOUT_MS,
    tickSkipReason({
      quietHours: !inStaffingHours(),
      missingKey: inboxkit ? null : "inboxkit",
    }),
    async (tick) => {
      progress("inboxkit", tick, "list_mailboxes");
      const book = await store.loadInventory();
      const seats = await inboxkit!.listMailboxes(tick.signal);
      const result = await runInboxkitSweep({
        seats,
        accounts: book?.accounts ?? [],
        gate,
      });
      console.log(formatStageOkLog("inboxkit", { intendedDeletes: result.deleted, elapsed_ms: tick.elapsedMs() }));
    },
  );
}

function scheduleTicks(name: string, pass: () => Promise<void>): void {
  cron.schedule(
    "*/15 * * * *",
    () => {
      void pass();
    },
    { timezone: "America/Chicago" },
  );
  setInterval(() => {
    void pass();
  }, TICK_INTERVAL_MS);
  console.log(`[v2] ${name} scheduler registered cron=*/15 interval_ms=${TICK_INTERVAL_MS}`);
}

if (runStaff) {
  const purged = await store.purgePendingIntents("attach");
  console.log(`[v2] staff boot purged pending attach=${purged}`);
  scheduleTicks("staff", staffPass);
  cron.schedule(
    "16 8 * * 1-5",
    () => {
      void inboxkitPass();
    },
    { timezone: "America/Chicago" },
  );
  console.log("[v2] staff boot tick");
  await staffPass();
}

if (runIsolation) {
  scheduleTicks("isolation", isolationPass);
  console.log("[v2] isolation boot tick");
  await isolationPass();
}

process.on("SIGTERM", () => process.exit(0));
