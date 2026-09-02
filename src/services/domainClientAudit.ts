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
import { isGenericMailbox } from "../lib/clientInbox.js";
import {
  confidentClientForDomain,
  GENERIC_CLIENT_NAME,
  GENERIC_TAG,
  hasPoolMarkerTag,
  isMarkerClientName,
  POC_CLIENT_NAME,
} from "../lib/markerClients.js";
import { sleep } from "../lib/http.js";
import type { DomainClientAdvisory } from "../state/store.js";
import type { StateStore } from "../state/store.js";
import type { InventoryBook } from "./inventory.js";
import { owesWarmup } from "./warmupGate.js";

/** Client-id / tag writes per pass — the rest converges on later passes. */
const ATTACH_CAP = 40;
/** Smartlead caps tag mapping writes at 25 accounts per call. */
const TAG_BATCH = 25;

export interface DomainClientAuditResult {
  advisories: DomainClientAdvisory[];
  attached: Array<{ domain: string; clientName: string; mailboxes: number }>;
  tagged: number;
  detached: number;
  leftoverMarkerClients: string[];
}

/**
 * D136/D142/D160 — a domain whose client story does not add up is first
 * offered a CONFIDENT fix, then a human question — never a guess.
 *
 * Generic and POC are mailbox tags, never Smartlead clients (D160):
 * - a generic-fleet / pool box missing GENERIC/POC gets the GENERIC tag;
 * - a leftover D142 Generic/POC client_id is cleared (the tag stays);
 * - those leftover client records are never recreated. Smartlead has no
 *   delete-client API; once detached, Josh deletes them in the UI.
 *
 * Real-client attach (D142/D143) is unchanged:
 * - an unmapped domain whose base name contains exactly one client's
 *   distinctive token has its unassigned, warmed boxes attached;
 * - everything else stays an advisory. split_clients is always advisory.
 *   A box that already carries a real client_id is never rewritten here.
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
      "ensureTag" | "assignTags" | "updateEmailAccount"
    >,
    /** Space between writes (D135 taught us the burst 429s). */
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

    const leftover = this.stampLeftoverMarkers(clients);
    const attached: DomainClientAuditResult["attached"] = [];
    let writesLeft = ATTACH_CAP;
    let tagged = 0;
    let detached = 0;

    if (this.smartlead && !this.config.dryRun) {
      const drain = await this.tagAndDetachGenerics(accounts, writesLeft);
      tagged = drain.tagged;
      detached = drain.detached;
      writesLeft = drain.writesLeft;
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
        if (this.state.isMarkerClientId(client.clientId)) continue;
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
          // D143 — a box that still owes warmup days is not attach supply.
          const unassigned = domainAccounts.filter(
            (account) => account.client_id == null,
          );
          const ready = unassigned.filter((account) => {
            const email = accountEmail(account)?.toLowerCase() ?? "";
            return !owesWarmup(account, email, this.config, this.state);
          });
          const deferred = unassigned.length - ready.length;
          let done = 0;
          for (const account of ready) {
            if (writesLeft <= 0) break;
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
          }
          if (deferred > 0) {
            advisories.push({
              domain,
              kind: "unmapped",
              note: `${deferred} mailbox(es) match ${match.clientName} but still owe the 21-day warmup — attach happens when it is served (D143)`,
              at: now,
            });
            console.log(
              `[domain-client] deferred ${deferred} mailbox(es) on ${domain} → ${match.clientName} until warmup is served (D143)`,
            );
          }
          if (done || deferred > 0) continue;
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
    if (leftover.names.length) {
      console.log(
        `[domain-client] leftover Smartlead clients ${leftover.names.join(" + ")} still exist — mailboxes are tagged GENERIC and detached; delete those empty clients in the Smartlead UI to stop billing (no delete-client API, D160)`,
      );
    }
    return {
      advisories,
      attached,
      tagged,
      detached,
      leftoverMarkerClients: leftover.names,
    };
  }

  /**
   * D160 — stamp leftover Generic/POC client ids when they still exist
   * in the book so classifiers can drain them. Never create. Clear the
   * stamp when Josh has deleted them.
   */
  private stampLeftoverMarkers(
    clients: Array<{ id: number; name?: string | null; logo?: string | null }>,
  ): { genericId?: number; pocId?: number; names: string[] } {
    const stamped = this.state.getMarkerClientIds();
    const found: { genericId?: number; pocId?: number } = {};
    const names: string[] = [];
    for (const client of clients) {
      if (isMarkerClientName(client.name) || isMarkerClientName(client.logo)) {
        names.push(String(client.name ?? client.logo ?? client.id));
      }
      if (
        String(client.name ?? "").trim().toLowerCase() ===
        GENERIC_CLIENT_NAME.toLowerCase()
      ) {
        found.genericId = client.id;
      }
      if (
        String(client.name ?? "").trim().toLowerCase() ===
        POC_CLIENT_NAME.toLowerCase()
      ) {
        found.pocId = client.id;
      }
    }
    if (
      found.genericId !== stamped.genericId ||
      found.pocId !== stamped.pocId
    ) {
      this.state.setMarkerClientIds(found);
    }
    return { ...found, names };
  }

  /**
   * Tag generic-pool boxes GENERIC and clear leftover D142 client_ids.
   * Tag first so classification survives the detach on the next pass.
   */
  private async tagAndDetachGenerics(
    accounts: SmartleadAccountWithCampaigns[],
    writesLeft: number,
  ): Promise<{ tagged: number; detached: number; writesLeft: number }> {
    const isolationDomain = effectiveIsolationDomain(this.config, this.state);
    const needTag: number[] = [];
    const needDetach: SmartleadAccountWithCampaigns[] = [];

    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (!email || !account.id) continue;
      if (this.state.getPoolMailbox(email)?.copyCanary) continue;
      if (this.state.isCopyCanary?.(email)) continue;
      const domain = email.split("@")[1];
      if (isolationDomain && domain === isolationDomain) continue;
      if (domain && this.state.getDomainHistory(domain)?.status === "retired") {
        continue;
      }

      const leftoverAssigned =
        typeof account.client_id === "number" &&
        this.state.isMarkerClientId(account.client_id);
      const generic = isGenericMailbox(account, email, this.config, this.state);
      if (!generic && !leftoverAssigned) continue;

      if (!hasPoolMarkerTag(account)) needTag.push(account.id);
      if (leftoverAssigned) needDetach.push(account);
    }

    let tagged = 0;
    let detached = 0;
    if (!this.smartlead) {
      return { tagged, detached, writesLeft };
    }

    if (needTag.length && writesLeft > 0) {
      try {
        const tag = await this.smartlead.ensureTag(GENERIC_TAG, "#66BB6A");
        for (const batch of chunk(needTag.slice(0, writesLeft), TAG_BATCH)) {
          await this.smartlead.assignTags(batch, [tag.id]);
          tagged += batch.length;
          writesLeft -= batch.length;
          await this.pause();
          if (writesLeft <= 0) break;
        }
        if (tagged) {
          console.log(
            `[domain-client] tagged ${tagged} mailbox(es) ${GENERIC_TAG} (pool label, D160)`,
          );
        }
      } catch (error) {
        console.warn(
          `[domain-client] GENERIC tag converge failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    for (const account of needDetach) {
      if (writesLeft <= 0) break;
      try {
        await this.smartlead.updateEmailAccount(account.id, { client_id: null });
        account.client_id = null;
        writesLeft -= 1;
        detached += 1;
        await this.pause();
      } catch (error) {
        console.warn(
          `[domain-client] detach ${accountEmail(account)} from leftover marker client failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (detached) {
      console.log(
        `[domain-client] cleared leftover Generic/POC client_id on ${detached} mailbox(es) (D160)`,
      );
    }
    return { tagged, detached, writesLeft };
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
