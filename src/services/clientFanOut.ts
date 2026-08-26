import type { AppConfig } from "../config.js";
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
import type { SmartleadCampaign } from "../types/index.js";
import { isBcpCampaignName, isBcpOwnedDomain } from "../lib/bcp.js";
import { isRetiredSendingDomain } from "../lib/domainControl.js";
import { isGenericMailbox } from "../lib/clientInbox.js";
import { campaignMayTakeGenerics } from "../lib/genericBackfill.js";
import { sleep } from "../lib/http.js";
import { isExcluded } from "./campaignTopUp.js";
import { activeHoldUntilDate, owesWarmup, tagNames } from "./warmupGate.js";
import {
  fetchInventory,
  recordMembership,
  type InventorySnapshot,
} from "./inventory.js";
import type { StateStore } from "../state/store.js";

/**
 * D26 — One *client* per sender, but every mailbox for that client should sit
 * on every ACTIVE campaign for that client (BCP mailboxes → all BCP
 * campaigns, Parlay → all Parlay, etc.). Membership is additive for
 * same-client campaigns.
 */

const ADD_BATCH_SIZE = 40;

export interface FanOutAttachment {
  email: string;
  accountId: number;
  campaignId: number;
  campaignName: string;
  clientKey: string;
}

export interface ClientFanOutResult {
  dryRun: boolean;
  groups: number;
  attached: FanOutAttachment[];
  skipped: string[];
  errors: string[];
}

function clientGroupKey(
  campaign: SmartleadCampaign,
): string | null {
  if (typeof campaign.client_id === "number") return `id:${campaign.client_id}`;
  // BCP campaigns sometimes share branding without a clean client_id.
  if (isBcpCampaignName(String(campaign.name ?? ""))) return "bcp";
  return null;
}

export class ClientFanOutService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: { dryRun?: boolean; inventory?: InventorySnapshot } = {},
  ): Promise<ClientFanOutResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: ClientFanOutResult = {
      dryRun,
      groups: 0,
      attached: [],
      skipped: [],
      errors: [],
    };

    const { campaigns, accounts, clients } =
      opts.inventory ?? (await fetchInventory(this.smartlead));

    const clientsById = new Map(clients.map((c) => [c.id, c]));
    const campaignClientById = new Map(
      (campaigns as SmartleadCampaign[]).map((c) => [c.id, c.client_id]),
    );

    const activeByGroup = new Map<string, SmartleadCampaign[]>();
    for (const campaign of campaigns as SmartleadCampaign[]) {
      if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") continue;
      if (isExcluded(campaign, this.config.topUpExcludeCampaigns)) continue;
      const key = clientGroupKey(campaign);
      if (!key) continue;
      const list = activeByGroup.get(key) ?? [];
      list.push(campaign);
      activeByGroup.set(key, list);
    }
    result.groups = activeByGroup.size;

    for (const [groupKey, groupCampaigns] of activeByGroup) {
      // A single-campaign group still fans out: a client inbox attached to
      // nothing (wiped, shell-stranded, freshly imported) must reach that
      // one live campaign. The old `length < 2` skip left whole clients at
      // one sender per campaign.
      const groupIds = new Set(groupCampaigns.map((c) => c.id));
      const groupIsBcp =
        groupKey === "bcp" ||
        groupCampaigns.some((campaign) =>
          isBcpCampaignName(String(campaign.name ?? "")),
        );
      const campaignName = new Map(
        groupCampaigns.map((c) => [c.id, String(c.name ?? c.id)]),
      );
      const approvals =
        typeof this.state.listGenericBackfillApprovals === "function"
          ? this.state.listGenericBackfillApprovals()
          : {};
      const campaignAllowsGenerics = (campaign: SmartleadCampaign): boolean => {
        const clientName =
          typeof campaign.client_id === "number"
            ? clientDisplayName(
                clientsById.get(campaign.client_id) ?? { id: campaign.client_id },
              )
            : "";
        return campaignMayTakeGenerics(
          campaign,
          clientName,
          this.config.pocClientNamePatterns,
          approvals,
        );
      };

      // campaignId → pending account attachments (batched Smartlead writes)
      const pendingByCampaign = new Map<
        number,
        Array<{
          accountId: number;
          email: string;
          account: SmartleadAccountWithCampaigns;
        }>
      >();

      for (const account of accounts as SmartleadAccountWithCampaigns[]) {
        const email = accountEmail(account);
        if (!email || !account.id) continue;

        // A benched mailbox must never be fanned back out. Remediation pulls a
        // sender for bad placement (D5) or bounce (D6) and tags it HOLD-UNTIL;
        // without this check fan-out re-attaches it to every ACTIVE campaign
        // for the client on the next 15-minute health pass, so held senders
        // keep reappearing on live campaigns. Top-up already filters on this.
        const domain = email.split("@")[1]?.toLowerCase();
        if (
          isRetiredSendingDomain(domain, this.state.getDomainHistory(domain))
        ) {
          result.skipped.push(`${email}: retired domain`);
          continue;
        }
        if (this.state.getHeldInbox(email)) {
          result.skipped.push(`${email}: held`);
          continue;
        }
        if (this.state.getRestingInbox(email)) {
          result.skipped.push(`${email}: resting`);
          continue;
        }
        if (activeHoldUntilDate(tagNames(account))) {
          result.skipped.push(`${email}: HOLD-UNTIL tag`);
          continue;
        }
        // D139 — the gate pulls under-warmed inboxes every pass; fanning the
        // same inboxes back out seconds later made the pull a no-op and the
        // 21-day clock (D1/D50/D105) fiction. Freshly imported client inboxes
        // wait out their clock; pre-warmed fleets and exempt tags still flow.
        if (owesWarmup(account, email, this.config, this.state)) {
          result.skipped.push(`${email}: owes warmup (D139)`);
          continue;
        }

        const generic = isGenericMailbox(account, email, this.config, this.state);

        const belongs = this.accountBelongsToGroup(
          account,
          groupKey,
          groupIds,
          campaignClientById,
          clientsById,
          groupIsBcp,
        );
        if (!belongs) continue;

        const on = new Set(campaignIdsOf(account));
        // D84 — a client-owned inbox belongs on every ACTIVE campaign for its
        // client even when it currently sits on zero of them (shell-stranded,
        // wiped, freshly imported). The old touches-the-group gate kept whole
        // fleets off their campaigns forever: only a mailbox already on one
        // group campaign could spread, so a detached inbox had no way back
        // (TechEvo and Peterson ran at 1 sender per campaign because of it).
        // Generics stay gated: an idle pool generic is top-up supply, not
        // fan-out supply, unless it already serves this group.
        const touchesGroup = [...on].some((id) => groupIds.has(id));
        const isBcpInventory =
          groupIsBcp && isBcpOwnedDomain(email.split("@")[1] ?? "");
        if (generic && !touchesGroup && !isBcpInventory) continue;

        for (const campaign of groupCampaigns) {
          if (on.has(campaign.id)) continue;
          if (generic && !campaignAllowsGenerics(campaign)) {
            result.skipped.push(
              `${email}: generics need POC or Slack approve on #${campaign.id}`,
            );
            continue;
          }
          const list = pendingByCampaign.get(campaign.id) ?? [];
          list.push({ accountId: account.id, email, account });
          pendingByCampaign.set(campaign.id, list);
        }
      }

      for (const [campaignId, pending] of pendingByCampaign) {
        const name = campaignName.get(campaignId) ?? String(campaignId);
        for (let i = 0; i < pending.length; i += ADD_BATCH_SIZE) {
          const chunk = pending.slice(i, i + ADD_BATCH_SIZE);
          const ids = chunk.map((p) => p.accountId);
          try {
            if (!dryRun) {
              await this.smartlead.addEmailAccountsToCampaign(campaignId, ids);
              await sleep(200);
              // D30: newly attached mailboxes must hold the 10m gap immediately.
              for (const row of chunk) {
                try {
                  await this.smartlead.updateEmailAccount(row.accountId, {
                    time_to_wait_in_mins: this.config.mailboxMinTimeGapMins,
                    max_email_per_day: this.config.messagePerDay,
                  });
                  await sleep(120);
                } catch (settingsError) {
                  const msg =
                    settingsError instanceof Error
                      ? settingsError.message
                      : String(settingsError);
                  result.errors.push(
                    `${row.email} gap/cap after fan-out: ${msg}`,
                  );
                }
              }
            }
            for (const row of chunk) {
              recordMembership(row.account, campaignId);
              result.attached.push({
                email: row.email,
                accountId: row.accountId,
                campaignId,
                campaignName: name,
                clientKey: groupKey,
              });
            }
            console.log(
              `[fan-out] ${groupKey} → #${campaignId} ${name}: +${chunk.length} (batch ${Math.floor(i / ADD_BATCH_SIZE) + 1})`,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            // Fall back to one-by-one so a single bad id doesn't block the batch.
            for (const row of chunk) {
              try {
                if (!dryRun) {
                  await this.smartlead.addEmailAccountsToCampaign(campaignId, [
                    row.accountId,
                  ]);
                  await sleep(150);
                  try {
                    await this.smartlead.updateEmailAccount(row.accountId, {
                      time_to_wait_in_mins: this.config.mailboxMinTimeGapMins,
                      max_email_per_day: this.config.messagePerDay,
                    });
                    await sleep(120);
                  } catch (settingsError) {
                    const msg =
                      settingsError instanceof Error
                        ? settingsError.message
                        : String(settingsError);
                    result.errors.push(
                      `${row.email} gap/cap after fan-out: ${msg}`,
                    );
                  }
                }
                recordMembership(row.account, campaignId);
                result.attached.push({
                  email: row.email,
                  accountId: row.accountId,
                  campaignId,
                  campaignName: name,
                  clientKey: groupKey,
                });
              } catch (inner) {
                const innerMsg =
                  inner instanceof Error ? inner.message : String(inner);
                result.errors.push(
                  `${row.email} → #${campaignId}: ${innerMsg}`,
                );
              }
            }
            if (!result.errors.some((e) => e.includes(`#${campaignId}`))) {
              result.errors.push(`#${campaignId} batch: ${message}`);
            }
          }
        }
      }
    }

    const skipReasons = new Map<string, number>();
    for (const line of result.skipped) {
      const reason = line.includes(": ")
        ? line.slice(line.indexOf(": ") + 2)
        : line;
      skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
    }
    console.log(
      `[fan-out] groups=${result.groups} attached=${result.attached.length} skipped=${result.skipped.length} errors=${result.errors.length}`,
    );
    if (skipReasons.size) {
      console.log(
        `[fan-out] skip reasons: ${[...skipReasons]
          .map(([reason, n]) => `${reason}=${n}`)
          .join(" ")}`,
      );
    }
    if (result.attached.length) {
      const byCampaign = new Map<string, number>();
      for (const row of result.attached) {
        const key = `#${row.campaignId} ${row.campaignName}`;
        byCampaign.set(key, (byCampaign.get(key) ?? 0) + 1);
      }
      try {
        await this.slack.send(
          [
            `${dryRun ? "Preview — " : ""}Same-client inboxes`,
            `If an inbox belongs to a client, it should sit on every live campaign for that client, not just one.`,
            ...[...byCampaign].map(
              ([name, n]) =>
                `• ${name} — added ${n} inbox${n === 1 ? "" : "es"} that way`,
            ),
          ].join("\n"),
        );
      } catch (error) {
        console.warn("[fan-out] Slack notify failed", error);
      }
    }

    return result;
  }

  private accountBelongsToGroup(
    account: SmartleadAccountWithCampaigns,
    groupKey: string,
    groupIds: Set<number>,
    campaignClientById: Map<number, number | null | undefined>,
    clientsById: Map<number, SmartleadClientRecord>,
    groupIsBcp = false,
  ): boolean {
    const email = accountEmail(account)?.toLowerCase() ?? "";
    const domain = email.split("@")[1] ?? "";

    // D99 — a BCP-owned domain belongs on BCP campaigns even when the
    // mailbox has no client_id (or the campaigns are tagged id:N).
    if (groupIsBcp && isBcpOwnedDomain(domain)) return true;

    if (groupKey === "bcp") {
      return (
        isBcpOwnedDomain(domain) ||
        campaignIdsOf(account).some((id) => groupIds.has(id))
      );
    }

    if (groupKey.startsWith("id:")) {
      const clientId = Number(groupKey.slice(3));
      const resolved = resolveAccountClient(
        account,
        campaignClientById,
        clientsById,
      );
      if (resolved.clientId === clientId) return true;
      // Pool generic branded to this client in state.
      const pool = this.state.getPoolMailbox(email);
      if (pool?.assignedClientId === clientId) return true;
      return campaignIdsOf(account).some(
        (id) => campaignClientById.get(id) === clientId,
      );
    }

    return false;
  }
}
