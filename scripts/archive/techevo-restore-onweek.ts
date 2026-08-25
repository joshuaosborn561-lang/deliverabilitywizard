/**
 * Live write: put TechEvo's on-week half back on ACTIVE TechEvo campaigns.
 * Does not START anything. Does not touch the paused pod-control shell.
 *
 * Usage: railway run -- npx tsx scripts/techevo-restore-onweek.ts
 */
import { loadConfig } from "../src/config.js";
import {
  SmartleadClient,
  accountEmail,
  campaignIdsOf,
} from "../src/clients/smartlead.js";
import { isPodControlShellCampaign } from "../src/lib/podControlShell.js";
import { isConnectedAccount } from "../src/lib/staffableSender.js";
import { tagNames, activeHoldUntilDate } from "../src/services/warmupGate.js";
import { assignClientCohorts, isOffWeek, onWeekCohort } from "../src/lib/restCohort.js";

const TECHEVO_CLIENT_ID = 521881;

async function main() {
  const config = loadConfig(process.env);
  const sl = new SmartleadClient(config.smartleadApiKey);
  const [campaigns, accounts] = await Promise.all([
    sl.listCampaigns(),
    sl.listAllEmailAccounts({ fetchCampaigns: true }),
  ]);

  const now = new Date();
  const onWeek = onWeekCohort(now);
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));

  const live = campaigns.filter((c) => {
    if (c.client_id !== TECHEVO_CLIENT_ID) return false;
    if (String(c.status ?? "").toUpperCase() !== "ACTIVE") return false;
    if (isPodControlShellCampaign(c)) return false;
    return true;
  });

  const rows = accounts.filter(
    (account) => account.client_id === TECHEVO_CLIENT_ID && account.id,
  );
  const emails = rows
    .map((account) => accountEmail(account))
    .filter((email): email is string => Boolean(email));
  const cohorts = assignClientCohorts(emails);

  const toAdd: Array<{ id: number; email: string; campaignId: number }> = [];
  const already: string[] = [];
  const skipped: string[] = [];

  for (const account of rows) {
    const email = accountEmail(account) ?? "";
    const cohort = cohorts.get(email);
    const tags = tagNames(account);
    const ids = campaignIdsOf(account);
    if (!cohort || isOffWeek(cohort, now)) {
      skipped.push(`${email}: off-week ${cohort ?? "?"} tags=${tags.join(",")}`);
      continue;
    }
    if (!isConnectedAccount(account)) {
      skipped.push(`${email}: disconnected`);
      continue;
    }
    if (activeHoldUntilDate(tags)) {
      skipped.push(`${email}: held`);
      continue;
    }
    for (const campaign of live) {
      if (ids.includes(campaign.id)) {
        already.push(`${email} already on #${campaign.id}`);
        continue;
      }
      toAdd.push({ id: account.id, email, campaignId: campaign.id });
    }
  }

  const plan = {
    onWeekCohort: onWeek,
    liveCampaigns: live.map((c) => ({ id: c.id, name: c.name, status: c.status })),
    inboxCount: rows.length,
    already,
    skipped,
    toAdd,
  };
  console.log(JSON.stringify({ plan: { ...plan, toAddCount: toAdd.length } }, null, 2));

  const byCampaign = new Map<number, number[]>();
  for (const row of toAdd) {
    const list = byCampaign.get(row.campaignId) ?? [];
    list.push(row.id);
    byCampaign.set(row.campaignId, list);
  }

  for (const [campaignId, ids] of byCampaign) {
    console.log(
      JSON.stringify({
        adding: ids.length,
        campaignId,
        emails: toAdd.filter((row) => row.campaignId === campaignId).map((r) => r.email),
      }),
    );
    await sl.addEmailAccountsToCampaign(campaignId, ids);
  }

  console.log(JSON.stringify({ done: true, added: toAdd.length }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
