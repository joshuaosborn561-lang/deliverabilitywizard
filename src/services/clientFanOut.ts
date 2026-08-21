import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  resolveAccountClient,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";
import { isBcpCampaignName, isBcpOwnedDomain } from "../lib/bcp.js";
import { sleep } from "../lib/http.js";
import { activeHoldUntilDate, tagNames } from "./warmupGate.js";
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

  async run(opts: { dryRun?: boolean } = {}): Promise<ClientFanOutResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: ClientFanOutResult = {
      dryRun,
      groups: 0,
      attached: [],
      skipped: [],
      errors: [],
    };

    const [campaigns, accounts, clients] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
    ]);

    const clientsById = new Map(clients.map((c) => [c.id, c]));
    const campaignClientById = new Map(
      (campaigns as SmartleadCampaign[]).map((c) => [c.id, c.client_id]),
    );

    const activeByGroup = new Map<string, SmartleadCampaign[]>();
    for (const campaign of campaigns as SmartleadCampaign[]) {
      if (String(campaign.status ?? "").toUpperCase() !== "ACTIVE") continue;
      // Exclusions (MSRS etc.) stay untouched.
      const excluded = this.config.topUpExcludeCampaigns.some((raw) => {
        const p = raw.trim().toLowerCase();
        if (!p) return false;
        return (
          p === String(campaign.id) ||
          String(campaign.name ?? "")
            .toLowerCase()
            .includes(p)
        );
      });
      if (excluded) continue;
      const key = clientGroupKey(campaign);
      if (!key) continue;
      const list = activeByGroup.get(key) ?? [];
      list.push(campaign);
      activeByGroup.set(key, list);
    }
    result.groups = activeByGroup.size;

    for (const [groupKey, groupCampaigns] of activeByGroup) {
      if (groupCampaigns.length < 2) continue;
      const groupIds = new Set(groupCampaigns.map((c) => c.id));
      const campaignName = new Map(
        groupCampaigns.map((c) => [c.id, String(c.name ?? c.id)]),
      );

      // campaignId → pending account attachments (batched Smartlead writes)
      const pendingByCampaign = new Map<
        number,
        Array<{ accountId: number; email: string }>
      >();

      for (const account of accounts as SmartleadAccountWithCampaigns[]) {
        const email = accountEmail(account);
        if (!email || !account.id) continue;

        // A benched mailbox must never be fanned back out. Remediation pulls a
        // sender for bad placement (D5) or bounce (D6) and tags it HOLD-UNTIL;
        // without this check fan-out re-attaches it to every ACTIVE campaign
        // for the client on the next 15-minute health pass, so held senders
        // keep reappearing on live campaigns. Top-up already filters on this.
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

        const belongs = this.accountBelongsToGroup(
          account,
          groupKey,
          groupIds,
          campaignClientById,
          clientsById,
        );
        if (!belongs) continue;

        const on = new Set(campaignIdsOf(account));
        // Only fan out mailboxes that already serve at least one campaign in
        // the group (or are BCP-owned inventory for the BCP group). Idle
        // generics stay for top-up; idle BCP domains are handled here too.
        const touchesGroup = [...on].some((id) => groupIds.has(id));
        const isBcpInventory =
          groupKey === "bcp" && isBcpOwnedDomain(email.split("@")[1] ?? "");
        if (!touchesGroup && !isBcpInventory) continue;

        for (const campaign of groupCampaigns) {
          if (on.has(campaign.id)) continue;
          const list = pendingByCampaign.get(campaign.id) ?? [];
          list.push({ accountId: account.id, email });
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

    console.log(
      `[fan-out] groups=${result.groups} attached=${result.attached.length} errors=${result.errors.length}`,
    );
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
  ): boolean {
    const email = accountEmail(account)?.toLowerCase() ?? "";
    const domain = email.split("@")[1] ?? "";

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
