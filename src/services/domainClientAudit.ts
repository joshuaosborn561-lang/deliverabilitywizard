import type { AppConfig } from "../config.js";
import {
  accountEmail,
  resolveAccountClient,
  type SmartleadAccountWithCampaigns,
  type SmartleadClient,
} from "../clients/smartlead.js";
import { isBcpOwnedDomain } from "../lib/bcp.js";
import { isFleetDomain } from "../lib/domainControl.js";
import { effectiveIsolationDomain } from "../lib/isolationDomain.js";
import {
  confidentClientForDomain,
  GENERIC_CLIENT_EMAIL,
  GENERIC_CLIENT_NAME,
  POC_CLIENT_EMAIL,
  POC_CLIENT_NAME,
} from "../lib/markerClients.js";
import { sleep } from "../lib/http.js";
import type { DomainClientAdvisory } from "../state/store.js";
import type { StateStore } from "../state/store.js";
import type { InventoryBook } from "./inventory.js";

/** Client-id writes per pass — the rest converges on later passes. */
const ATTACH_CAP = 40;

export interface DomainClientAuditResult {
  advisories: DomainClientAdvisory[];
  attached: Array<{ domain: string; clientName: string; mailboxes: number }>;
}

/**
 * D136/D142 — a domain whose client story does not add up is first offered
 * a CONFIDENT fix, then a human question — never a guess.
 *
 * The pass ensures the Generic and POC marker clients exist (D142 — pools
 * as client records; boxes assigned to them are generics, not client
 * inboxes), then:
 *
 * - a box on a generic-fleet domain (EXTRA_GENERIC_DOMAINS) with NO
 *   client_id is assigned to the Generic marker;
 * - an unmapped domain whose base name contains exactly one client's
 *   distinctive token (salesglider→SalesGlider, parlay→Parlay Tech) has
 *   its unassigned boxes attached to that client;
 * - everything else stays an advisory: logs plus one line on the EOD
 *   brief. split_clients is always advisory. A box that already carries a
 *   real client_id is never rewritten here (the staged POC re-point is
 *   D142's explicit follow-up, decided by Josh — not this pass).
 *
 * Skipped on purpose: BCP-owned replacement domains (BCP even with no
 * client_id, D99), the isolation domain, the canary fleet, and retired
 * domains.
 */
export class DomainClientAuditService {
  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly book: InventoryBook,
    private readonly smartlead?: Pick<
      SmartleadClient,
      "ensureClient" | "updateEmailAccount"
    >,
    /** Space between client-id writes (D135 taught us the burst 429s). */
    private readonly pause: () => Promise<void> = () =>
      sleep(process.env.NODE_TEST_CONTEXT ? 0 : 1000),
  ) {}

  async run(): Promise<DomainClientAuditResult> {
    const { campaigns, accounts, clients } = await this.book.get();
    const campaignClient = new Map(
      campaigns.map((campaign) => [campaign.id, campaign.client_id]),
    );
    const clientsById = new Map(clients.map((client) => [client.id, client]));
    const isolationDomain = effectiveIsolationDomain(this.config, this.state);

    const markers = await this.ensureMarkers(clients);
    const attached: DomainClientAuditResult["attached"] = [];
    let writesLeft = ATTACH_CAP;

    // D142 — generic-fleet boxes with no client belong to the Generic
    // marker. Boxes already carrying a real client_id are left alone.
    if (this.smartlead && markers.genericId != null && !this.config.dryRun) {
      const orphans = accounts.filter((account) => {
        const email = accountEmail(account)?.toLowerCase();
        const domain = email?.split("@")[1];
        if (!email || !domain) return false;
        if (!isFleetDomain(domain, this.config.extraGenericDomains)) return false;
        return account.client_id == null;
      });
      const byDomain = new Map<string, SmartleadAccountWithCampaigns[]>();
      for (const account of orphans) {
        const domain = accountEmail(account)!.toLowerCase().split("@")[1]!;
        const list = byDomain.get(domain) ?? [];
        list.push(account);
        byDomain.set(domain, list);
      }
      for (const [domain, list] of byDomain) {
        let done = 0;
        for (const account of list) {
          if (writesLeft <= 0) break;
          try {
            await this.smartlead.updateEmailAccount(account.id, {
              client_id: markers.genericId,
            });
            writesLeft -= 1;
            done += 1;
            await this.pause();
          } catch (error) {
            console.warn(
              `[domain-client] attach ${accountEmail(account)} → ${GENERIC_CLIENT_NAME} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (done) {
          attached.push({
            domain,
            clientName: GENERIC_CLIENT_NAME,
            mailboxes: done,
          });
          console.log(
            `[domain-client] attached ${done} mailbox(es) on ${domain} → ${GENERIC_CLIENT_NAME} (generic pool, D142)`,
          );
        }
      }
    }

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
        // D142 — the confident fix first: exactly one client's token in
        // the domain base attaches the unassigned boxes to that client.
        const match = this.smartlead
          ? confidentClientForDomain(domain, clients)
          : null;
        if (match && !this.config.dryRun && writesLeft > 0) {
          let done = 0;
          for (const account of domainAccounts) {
            if (writesLeft <= 0) break;
            if (account.client_id != null) continue;
            try {
              await this.smartlead!.updateEmailAccount(account.id, {
                client_id: match.clientId,
              });
              writesLeft -= 1;
              done += 1;
              await this.pause();
            } catch (error) {
              console.warn(
                `[domain-client] attach ${accountEmail(account)} → ${match.clientName} failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (done) {
            attached.push({
              domain,
              clientName: match.clientName,
              mailboxes: done,
            });
            console.log(
              `[domain-client] attached ${done} mailbox(es) on ${domain} → ${match.clientName} (confident match, D142)`,
            );
            continue;
          }
        }
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
    return { advisories, attached };
  }

  /**
   * D142 — the Generic and POC marker clients exist and their ids are
   * stamped in state so classifiers can recognise them. Reads come from
   * the shared book; a create happens at most once per marker.
   */
  private async ensureMarkers(
    clients: Array<{ id: number; name?: string | null }>,
  ): Promise<{ genericId?: number; pocId?: number }> {
    const stamped = this.state.getMarkerClientIds();
    const found = { ...stamped };
    const byName = (name: string) =>
      clients.find(
        (client) =>
          String(client.name ?? "").trim().toLowerCase() === name.toLowerCase(),
      )?.id;

    const genericInBook = byName(GENERIC_CLIENT_NAME);
    if (genericInBook != null) found.genericId = genericInBook;
    const pocInBook = byName(POC_CLIENT_NAME);
    if (pocInBook != null) found.pocId = pocInBook;

    if (this.smartlead && !this.config.dryRun) {
      try {
        if (found.genericId == null) {
          found.genericId = await this.smartlead.ensureClient(
            GENERIC_CLIENT_NAME,
            GENERIC_CLIENT_EMAIL,
          );
          console.log(
            `[domain-client] created marker client ${GENERIC_CLIENT_NAME} (#${found.genericId})`,
          );
        }
        if (found.pocId == null) {
          found.pocId = await this.smartlead.ensureClient(
            POC_CLIENT_NAME,
            POC_CLIENT_EMAIL,
          );
          console.log(
            `[domain-client] created marker client ${POC_CLIENT_NAME} (#${found.pocId})`,
          );
        }
      } catch (error) {
        console.warn(
          `[domain-client] marker ensure failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (
      found.genericId !== stamped.genericId ||
      found.pocId !== stamped.pocId
    ) {
      this.state.setMarkerClientIds(found);
    }
    return found;
  }
}
