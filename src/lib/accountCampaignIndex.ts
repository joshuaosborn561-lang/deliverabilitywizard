import {
  accountEmail,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { runWithStallScopeAsync } from "./eventLoopAttribution.js";
import {
  pauseWhileHealthLive,
  pauseWhileOverdueCanonOps,
  pauseWhileSlackInteraction,
} from "./healthCpuPause.js";
import {
  createTimeSlicer,
  yieldEventLoop,
} from "./stringifyYielding.js";

export const INDEX_ACCOUNTS_YIELD_EVERY = 32;
export const INDEX_IDS_YIELD_EVERY = 32;
export const INDEX_SLICE_MS = 8;

export interface IndexAccountsOpts {
  /**
   * D272 — campaign-audit passes healthLock.isLive so the index yields
   * the CPU when a health sitting starts mid-walk. Health / min40 /
   * campaign-check omit this (they *are* the health cycle).
   */
  pauseWhile?: () => boolean;
  /**
   * D293 — min40 / surplus-return (the overdue canon-ops holder) must
   * not wait on the exclusive flag they themselves set.
   */
  skipOverduePause?: boolean;
}

/**
 * Iterate membership ids without mapping a fat `campaigns[]` into a
 * new array first (D271 slim pages have `campaign_ids`; leftover fat
 * pages still carry `campaigns[]`).
 */
function* membershipIds(
  account: SmartleadAccountWithCampaigns,
): Generator<number> {
  const seen = new Set<number>();
  if (Array.isArray(account.campaign_ids) && account.campaign_ids.length) {
    for (const n of account.campaign_ids) {
      if (typeof n !== "number" || !Number.isFinite(n) || seen.has(n)) continue;
      seen.add(n);
      yield n;
    }
    return;
  }
  if (!Array.isArray(account.campaigns)) return;
  for (const row of account.campaigns) {
    const n = row && typeof row === "object" ? (row.id ?? row.campaign_id) : null;
    if (typeof n !== "number" || !Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    yield n;
  }
}

function accountIndexKey(
  account: SmartleadAccountWithCampaigns,
): string | null {
  if (typeof account.id === "number" && Number.isFinite(account.id)) {
    return `id:${account.id}`;
  }
  const email = accountEmail(account)?.toLowerCase();
  return email ? `email:${email}` : null;
}

/** One pass so later walks do not rescan every mailbox for every campaign. */
export async function indexAccountsByCampaign(
  accounts: SmartleadAccountWithCampaigns[],
  opts: IndexAccountsOpts = {},
): Promise<Map<number, SmartleadAccountWithCampaigns[]>> {
  return runWithStallScopeAsync("scan:indexAccountsByCampaign", async () => {
    await yieldEventLoop();
    const slice = createTimeSlicer(INDEX_SLICE_MS);
    const byCampaign = new Map<number, SmartleadAccountWithCampaigns[]>();
    const seenByCampaign = new Map<number, Set<string>>();
    let accountsN = 0;
    let idsN = 0;
    const yieldCpu = async (): Promise<void> => {
      await yieldEventLoop();
      await pauseWhileHealthLive(opts.pauseWhile, {
        label: "scan:indexAccountsByCampaign",
      });
      await pauseWhileOverdueCanonOps({
        label: "scan:indexAccountsByCampaign",
        skip: opts.skipOverduePause,
      });
      await pauseWhileSlackInteraction({
        label: "scan:indexAccountsByCampaign",
      });
    };
    for (const account of accounts) {
      for (const id of membershipIds(account)) {
        const key = accountIndexKey(account);
        if (key) {
          const seen = seenByCampaign.get(id) ?? new Set();
          if (seen.has(key)) continue;
          seen.add(key);
          seenByCampaign.set(id, seen);
        }
        const list = byCampaign.get(id);
        if (list) list.push(account);
        else byCampaign.set(id, [account]);
        idsN += 1;
        if (idsN % INDEX_IDS_YIELD_EVERY === 0) await yieldCpu();
        else await slice();
      }
      accountsN += 1;
      if (accountsN % INDEX_ACCOUNTS_YIELD_EVERY === 0) await yieldCpu();
    }
    return byCampaign;
  });
}

export async function indexAccountsByEmail(
  accounts: SmartleadAccountWithCampaigns[],
  opts: IndexAccountsOpts = {},
): Promise<Map<string, SmartleadAccountWithCampaigns>> {
  return runWithStallScopeAsync("scan:indexAccountsByEmail", async () => {
    await yieldEventLoop();
    const slice = createTimeSlicer(INDEX_SLICE_MS);
    const byEmail = new Map<string, SmartleadAccountWithCampaigns>();
    let n = 0;
    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (email) byEmail.set(email, account);
      n += 1;
      if (n % INDEX_ACCOUNTS_YIELD_EVERY === 0) {
        await yieldEventLoop();
        await pauseWhileHealthLive(opts.pauseWhile, {
          label: "scan:indexAccountsByEmail",
        });
        await pauseWhileOverdueCanonOps({
          label: "scan:indexAccountsByEmail",
          skip: opts.skipOverduePause,
        });
        await pauseWhileSlackInteraction({
          label: "scan:indexAccountsByEmail",
        });
      } else {
        await slice();
      }
    }
    return byEmail;
  });
}
