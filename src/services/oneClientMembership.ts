import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import {
  brandFromClientDisplayName,
  clientBrandList,
  findForeignBrand,
} from "../lib/clientBrand.js";
import { isolationEmailsOf, isIsolationEmail } from "../lib/isolationDomain.js";
import { desiredMailboxSignature } from "../lib/mailboxSignature.js";
import { foreignCampaignIds, ownerClientId, type MembershipRow } from "../lib/oneClient.js";
import { isPodControlShellCampaign } from "../lib/podControlShell.js";
import { sleep } from "../lib/http.js";
import { signatureHay } from "../lib/signatureQa.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

export interface OneClientMembershipResult {
  dryRun: boolean;
  examined: number;
  pulled: Array<{ email: string; campaignId: number }>;
  signaturesSet: number;
  skipped: string[];
  errors: string[];
}

/**
 * D75 — every health pass: an inbox may only sit on one client's campaigns.
 * The paused pod-control shell does not count. Signature is rewritten to
 * the owner client's brand when a leftover line is another client.
 */
export class OneClientMembershipService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<OneClientMembershipResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: OneClientMembershipResult = {
      dryRun,
      examined: 0,
      pulled: [],
      signaturesSet: 0,
      skipped: [],
      errors: [],
    };

    const [campaigns, accounts, clients] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
    ]);
    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((campaign) => [campaign.id, campaign]),
    );
    const brandByClientId = new Map<number, string>();
    for (const client of clients) {
      brandByClientId.set(
        client.id,
        brandFromClientDisplayName(clientDisplayName(client)),
      );
    }
    const allBrands = clientBrandList(clients);
    const isolation = {
      emails: isolationEmailsOf(this.config.isolationMailboxEmails),
      domain: this.config.isolationDomain || undefined,
    };

    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;
      if (this.state.isCopyCanary(email)) continue;
      if (isIsolationEmail(email, isolation)) continue;

      const memberships: MembershipRow[] = campaignIdsOf(account).map((id) => {
        const campaign = campaignById.get(id);
        return {
          campaignId: id,
          clientId:
            typeof campaign?.client_id === "number" ? campaign.client_id : null,
          shell: campaign ? isPodControlShellCampaign(campaign) : false,
        };
      });
      if (!memberships.length) continue;
      result.examined += 1;

      const owner = ownerClientId(account.client_id, memberships);
      if (owner == null) {
        result.skipped.push(`${email}: no single owner client`);
        continue;
      }

      const pull = foreignCampaignIds(owner, memberships);
      for (const campaignId of pull) {
        try {
          if (!dryRun) {
            await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
              account.id,
            ]);
            await sleep(150);
          }
          result.pulled.push({ email, campaignId });
          console.log(
            `[one-client] ${email} off #${campaignId} (owner client ${owner})`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`${email} remove #${campaignId}: ${message}`);
        }
      }

      const clientBrand = brandByClientId.get(owner) ?? "";
      if (!clientBrand) continue;
      const hay = signatureHay({
        fromName: account.from_name,
        signature: account.signature,
      });
      const foreign = findForeignBrand(hay, clientBrand, allBrands);
      const desired = desiredMailboxSignature({
        fromName: account.from_name,
        signature: account.signature,
        clientBrand,
        otherClientBrands: allBrands.filter((brand) => brand !== clientBrand),
      });
      if (!foreign || !desired || (account.signature ?? "") === desired) continue;
      try {
        if (!dryRun) {
          await this.smartlead.updateEmailAccount(account.id, {
            signature: desired,
            client_id: owner,
          });
          await sleep(150);
        }
        result.signaturesSet += 1;
        console.log(
          `[one-client] ${email} signature → ${clientBrand}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${email} signature: ${message}`);
      }
    }

    console.log(
      `[one-client] examined=${result.examined} pulled=${result.pulled.length} signatures=${result.signaturesSet} errors=${result.errors.length}`,
    );
    return result;
  }
}
