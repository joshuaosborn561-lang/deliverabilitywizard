import type { AppConfig } from "../config.js";
import {
  accountEmail,
  resolveAccountClient,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { isBcpOwnedDomain } from "../lib/bcp.js";
import { isFleetDomain } from "../lib/domainControl.js";
import { normalizeIsolationDomain } from "../lib/isolationDomain.js";
import type { DomainClientAdvisory } from "../state/store.js";
import type { StateStore } from "../state/store.js";
import type { InventoryBook } from "./inventory.js";

export interface DomainClientAuditResult {
  advisories: DomainClientAdvisory[];
}

/**
 * D136 — a domain whose client story does not add up is a human question,
 * never a guess. Two shapes are flagged: a sending domain whose mailboxes
 * resolve to more than one client (one-client-per-sender says that cannot
 * be right at the domain level either), and a domain none of whose
 * mailboxes resolve to any client (unmapped — fan-out and floors cannot
 * see it). Advisory only: logs plus one line on the EOD brief. The audit
 * never writes a client_id anywhere.
 *
 * Skipped on purpose: the pre-warmed generic fleets (they are POC by rule,
 * D19/D76), BCP-owned replacement domains (BCP even with no client_id,
 * D99), the isolation domain, the canary fleet, and retired domains.
 */
export class DomainClientAuditService {
  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly book: InventoryBook,
  ) {}

  async run(): Promise<DomainClientAuditResult> {
    const { campaigns, accounts, clients } = await this.book.get();
    const campaignClient = new Map(
      campaigns.map((campaign) => [campaign.id, campaign.client_id]),
    );
    const clientsById = new Map(clients.map((client) => [client.id, client]));
    const isolationDomain = normalizeIsolationDomain(
      this.config.isolationDomain,
    );

    const byDomain = new Map<string, SmartleadAccountWithCampaigns[]>();
    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      const domain = email?.split("@")[1];
      if (!email || !domain) continue;
      if (isFleetDomain(domain, this.config.extraGenericDomains)) continue;
      if (isBcpOwnedDomain(domain)) continue;
      if (isolationDomain && domain === isolationDomain) continue;
      if (this.state.getPoolMailbox(email)?.copyCanary) continue;
      if (this.state.getDomainHistory(domain)?.status === "retired") continue;
      const list = byDomain.get(domain) ?? [];
      list.push(account);
      byDomain.set(domain, list);
    }

    const now = new Date().toISOString();
    const advisories: DomainClientAdvisory[] = [];
    for (const [domain, domainAccounts] of byDomain) {
      const names = new Map<string, number>();
      let mapped = 0;
      for (const account of domainAccounts) {
        const client = resolveAccountClient(account, campaignClient, clientsById);
        if (client.clientId == null) continue;
        mapped += 1;
        names.set(client.clientName, (names.get(client.clientName) ?? 0) + 1);
      }
      if (names.size > 1) {
        const split = [...names.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => `${name} (${count})`)
          .join(", ");
        advisories.push({
          domain,
          kind: "split_clients",
          note: `mailboxes resolve to ${names.size} clients: ${split}`,
          at: now,
        });
      } else if (mapped === 0) {
        advisories.push({
          domain,
          kind: "unmapped",
          note: `${domainAccounts.length} mailbox(es), none resolve to a client`,
          at: now,
        });
      }
    }

    this.state.setDomainAdvisories(advisories);
    for (const advisory of advisories) {
      console.log(
        `[domain-client] ${advisory.kind} ${advisory.domain} — ${advisory.note}`,
      );
    }
    if (!advisories.length) {
      console.log("[domain-client] every sending domain maps to one client");
    }
    return { advisories };
  }
}
