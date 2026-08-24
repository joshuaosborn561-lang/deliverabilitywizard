import type { InboxKitClient, InboxKitMailbox } from "../clients/inboxkit.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  resolveAccountClient,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { AppConfig } from "../config.js";
import { isClientInbox, isGenericMailbox } from "../lib/clientInbox.js";
import {
  DEFAULT_VASCO_PATTERNS,
  DEFAULT_WIPE_CLIENT_PATTERNS,
  VASCO_KEEP_COUNT,
  nameHayMatches,
  pickKeepByMix,
  type EspBucket,
} from "../lib/clientWipe.js";
import { isCopyCanaryFleetDomain } from "../lib/copyCanaryFleet.js";
import { sleep } from "../lib/http.js";
import { poolEspFromSmartleadType } from "../lib/poolSignature.js";
import { isPrewarmedGeneric } from "./warmupGate.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

export interface ClientWipeResult {
  dryRun: boolean;
  skipped: boolean;
  vascoKept: string[];
  vascoDeleted: string[];
  wiped: string[];
  inboxKitCancelled: number;
  domainsPurged: string[];
  errors: string[];
}

/**
 * D61 — one-shot: Vasco down to 40 (same mix, all send). GXA / MSRS /
 * Nieto inboxes gone from Smartlead and InboxKit.
 */
export class ClientWipeService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly inboxkit: InboxKitClient | null,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<ClientWipeResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: ClientWipeResult = {
      dryRun,
      skipped: false,
      vascoKept: [],
      vascoDeleted: [],
      wiped: [],
      inboxKitCancelled: 0,
      domainsPurged: [],
      errors: [],
    };
    if (!this.config.enableClientWipe) {
      result.skipped = true;
      return result;
    }
    if (this.state.getClientWipeAt()) {
      result.skipped = true;
      return result;
    }

    const [campaigns, accounts, clients] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
    ]);
    const campaignClientById = new Map(
      (campaigns as SmartleadCampaign[]).map((campaign) => [
        campaign.id,
        campaign.client_id,
      ]),
    );
    const clientsById = new Map(clients.map((client) => [client.id, client]));
    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((campaign) => [campaign.id, campaign]),
    );
    const activeIds = new Set(
      (campaigns as SmartleadCampaign[])
        .filter((campaign) => String(campaign.status ?? "").toUpperCase() === "ACTIVE")
        .map((campaign) => campaign.id),
    );

    const hayFor = (account: SmartleadAccountWithCampaigns, email: string) => {
      const resolved = resolveAccountClient(
        account,
        campaignClientById,
        clientsById,
      );
      const campaignNames = campaignIdsOf(account)
        .map((id) => campaignById.get(id)?.name ?? "")
        .join(" ");
      return `${resolved.clientName} ${clientDisplayName(clientsById.get(resolved.clientId ?? -1))} ${campaignNames} ${email}`;
    };

    const vasco: SmartleadAccountWithCampaigns[] = [];
    const wipe: SmartleadAccountWithCampaigns[] = [];
    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;
      if (isGenericMailbox(account, email, this.config, this.state)) continue;
      if (this.isProtected(account, email)) continue;
      const hay = hayFor(account, email);
      if (nameHayMatches(hay, this.config.wipeClientPatterns.length
        ? this.config.wipeClientPatterns
        : DEFAULT_WIPE_CLIENT_PATTERNS)) {
        wipe.push(account);
        continue;
      }
      if (
        nameHayMatches(
          hay,
          this.config.fullSendClientPatterns.length
            ? this.config.fullSendClientPatterns
            : DEFAULT_VASCO_PATTERNS,
        ) &&
        isClientInbox(account, email, this.config, this.state)
      ) {
        vasco.push(account);
      }
    }

    const keep = new Set(
      pickKeepByMix(vasco, this.config.vascoKeepCount || VASCO_KEEP_COUNT, {
        esp: (account) => this.espOf(account),
        prefer: (account) =>
          campaignIdsOf(account).some((id) => activeIds.has(id)),
        key: (account) => accountEmail(account)!.toLowerCase(),
      }).map((account) => accountEmail(account)!.toLowerCase()),
    );
    result.vascoKept = [...keep].sort();
    const vascoCut = vasco.filter(
      (account) => !keep.has(accountEmail(account)!.toLowerCase()),
    );

    const toDelete = [...wipe, ...vascoCut];
    const deleteEmails = new Set<string>();
    for (const account of toDelete) {
      const email = accountEmail(account)!.toLowerCase();
      deleteEmails.add(email);
      if (wipe.includes(account)) result.wiped.push(email);
      else result.vascoDeleted.push(email);
      if (dryRun) continue;
      try {
        for (const campaignId of campaignIdsOf(account)) {
          await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
            account.id!,
          ]);
          await sleep(80);
        }
        await this.smartlead.deleteEmailAccount(account.id!);
        await sleep(80);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/404|not found|already/i.test(message)) continue;
        result.errors.push(`${email}: ${message}`);
      }
    }

    if (!dryRun && this.inboxkit && deleteEmails.size) {
      try {
        const ik = await this.scrubInboxKit(deleteEmails, accounts as SmartleadAccountWithCampaigns[]);
        result.inboxKitCancelled = ik.cancelled;
        result.domainsPurged = ik.purged;
        result.errors.push(...ik.errors);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`InboxKit: ${message}`);
      }
    }

    if (!dryRun && !result.errors.length) {
      this.state.markClientWipe(new Date().toISOString());
      await this.state.save();
    } else if (!dryRun) {
      await this.state.save();
    }

    console.log(
      `[client-wipe] vasco kept=${result.vascoKept.length} cut=${result.vascoDeleted.length} wiped=${result.wiped.length} inboxkit=${result.inboxKitCancelled} domains=${result.domainsPurged.length} errors=${result.errors.length}`,
    );

    if (!dryRun && (result.vascoDeleted.length || result.wiped.length)) {
      try {
        await this.slack.send(
          [
            "Client inbox cleanup",
            `Vasco is down to ${result.vascoKept.length} inboxes — same Google / Microsoft mix as before. All of them send; none sit.`,
            result.vascoDeleted.length
              ? `Removed ${result.vascoDeleted.length} extra Vasco inbox${result.vascoDeleted.length === 1 ? "" : "es"} from Smartlead and InboxKit.`
              : "",
            result.wiped.length
              ? `Wiped ${result.wiped.length} GXA / MSRS / Nieto inbox${result.wiped.length === 1 ? "" : "es"} from Smartlead and InboxKit.`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (error) {
        console.warn("[client-wipe] Slack notify failed", error);
      }
    }
    return result;
  }

  private isProtected(
    account: SmartleadAccountWithCampaigns,
    email: string,
  ): boolean {
    if (this.state.isCopyCanary(email)) return true;
    if (isPrewarmedGeneric(account, email, this.config, this.state)) return true;
    const domain = email.split("@")[1] ?? "";
    if (isCopyCanaryFleetDomain(domain, this.state.getCopyCanaryFleet())) {
      return true;
    }
    if (
      this.config.extraGenericDomains.some((row) => row.toLowerCase() === domain)
    ) {
      return true;
    }
    if (this.config.isolationDomain && domain === this.config.isolationDomain.toLowerCase()) {
      return true;
    }
    return false;
  }

  private espOf(account: SmartleadAccountWithCampaigns): EspBucket {
    return poolEspFromSmartleadType(account.type) ?? "OTHER";
  }

  private async scrubInboxKit(
    deleteEmails: Set<string>,
    remainingAccounts: SmartleadAccountWithCampaigns[],
  ): Promise<{ cancelled: number; purged: string[]; errors: string[] }> {
    const inboxkit = this.inboxkit!;
    const workspaces = await inboxkit.listWorkspaces();
    const protectedWs = this.config.genericPoolWorkspaceId.trim();
    const errors: string[] = [];
    let cancelled = 0;
    const domainsToConsider = new Set(
      [...deleteEmails].map((email) => email.split("@")[1] ?? "").filter(Boolean),
    );
    const stillLive = new Set<string>();
    for (const account of remainingAccounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (!email || deleteEmails.has(email)) continue;
      const domain = email.split("@")[1] ?? "";
      if (domain) stillLive.add(domain);
    }

    for (const workspace of workspaces) {
      const ws = workspace.uid || workspace.id;
      if (!ws || (protectedWs && ws === protectedWs)) continue;
      let mailboxes: InboxKitMailbox[] = [];
      try {
        mailboxes = await inboxkit.listAllMailboxes(ws);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`list ${ws}: ${message}`);
        continue;
      }
      const uids = mailboxes
        .filter((row) => {
          const email = inboxkitEmail(row);
          return email && deleteEmails.has(email);
        })
        .map((row) => row.uid || row.id)
        .filter((uid): uid is string => Boolean(uid));
      if (!uids.length) continue;
      try {
        await inboxkit.cancelMailboxes(uids, { workspaceId: ws });
        cancelled += uids.length;
        await sleep(120);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`cancel ${ws}: ${message}`);
      }
    }

    const purged: string[] = [];
    for (const domain of domainsToConsider) {
      if (stillLive.has(domain)) continue;
      if (this.config.extraGenericDomains.some((row) => row.toLowerCase() === domain)) {
        continue;
      }
      if (isCopyCanaryFleetDomain(domain, this.state.getCopyCanaryFleet())) continue;
      try {
        await inboxkit.purgeDomain(domain);
        purged.push(domain);
        await sleep(150);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not found/i.test(message) || /protected generic-pool/i.test(message)) {
          continue;
        }
        errors.push(`purge ${domain}: ${message}`);
      }
    }
    return { cancelled, purged, errors };
  }
}

function inboxkitEmail(row: InboxKitMailbox): string | null {
  const direct = (row.email || row.address || "").trim().toLowerCase();
  if (direct.includes("@")) return direct;
  const domain = (row.domain_name || row.domain || "").trim().toLowerCase();
  const user = (row.username || "").trim().toLowerCase();
  if (user && domain) return `${user}@${domain}`;
  return null;
}
