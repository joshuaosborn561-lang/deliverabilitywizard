/**
 * Live read: where TechEvo inboxes went. No writes.
 */
import { loadConfig } from "../src/config.js";
import {
  SmartleadClient,
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
} from "../src/clients/smartlead.js";
import { isConnectedAccount } from "../src/lib/staffableSender.js";
import { tagNames, activeHoldUntilDate } from "../src/services/warmupGate.js";
import { assignClientCohorts, isOffWeek, onWeekCohort } from "../src/lib/restCohort.js";

function n(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return 0;
}

async function main() {
  const config = loadConfig(process.env);
  const sl = new SmartleadClient(config.smartleadApiKey);
  const [campaigns, clients, accounts] = await Promise.all([
    sl.listCampaigns(),
    sl.listClients(),
    sl.listAllEmailAccounts({ fetchCampaigns: true }),
  ]);

  const techevoClients = clients.filter((c) =>
    /techevo|tech evo|new england/i.test(clientDisplayName(c)),
  );
  const techevoCampaigns = campaigns.filter((c) =>
    /techevo|tech evo/i.test(String(c.name ?? "")),
  );
  const techevoClientIds = new Set<number>([
    ...techevoClients.map((c) => c.id),
    ...techevoCampaigns
      .map((c) => c.client_id)
      .filter((id): id is number => typeof id === "number"),
  ]);

  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const now = new Date();
  const onWeek = onWeekCohort(now);

  const rows = accounts.filter((account) => {
    const email = accountEmail(account) ?? "";
    const onTechevo = campaignIdsOf(account).some((id) =>
      techevoCampaigns.some((c) => c.id === id),
    );
    const clientHit =
      typeof account.client_id === "number" &&
      techevoClientIds.has(account.client_id);
    const nameHit = /techevo|tech.?evo/i.test(
      `${account.from_name ?? ""} ${email}`,
    );
    return onTechevo || clientHit || nameHit;
  });

  const emails = rows.map((a) => accountEmail(a)).filter(Boolean) as string[];
  const cohorts = assignClientCohorts(emails);

  console.log(
    JSON.stringify({
      onWeekCohort: onWeek,
      clients: techevoClients.map((c) => ({
        id: c.id,
        name: clientDisplayName(c),
      })),
      campaigns: techevoCampaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        client_id: c.client_id,
      })),
      inboxCount: rows.length,
    }),
  );

  for (const account of rows) {
    const email = accountEmail(account) ?? "";
    const ids = campaignIdsOf(account);
    const membership = ids.map((id) => {
      const c = campaignById.get(id);
      return {
        id,
        name: c?.name ?? "(missing)",
        status: c?.status ?? "UNKNOWN",
      };
    });
    const live = membership.filter((m) => String(m.status).toUpperCase() === "ACTIVE");
    const cohort = cohorts.get(email);
    console.log(
      JSON.stringify({
        email,
        id: account.id,
        client_id: account.client_id,
        from_name: account.from_name,
        type: account.type,
        smtp: account.is_smtp_success,
        imap: account.is_imap_success,
        connected: isConnectedAccount(account),
        daily_sent: n(account.daily_sent_count),
        message_per_day: account.message_per_day,
        hold: activeHoldUntilDate(tagNames(account)),
        tags: tagNames(account),
        cohort,
        offWeek: cohort ? isOffWeek(cohort, now) : null,
        liveCampaigns: live,
        allCampaigns: membership,
      }),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
