import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type {
  SmartleadAccountWithCampaigns,
  SmartleadClient,
  SmartleadClientRecord,
} from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  resolveAccountClient,
} from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import { MATCH_THRESHOLD, scoreNameMatch } from "../lib/nameMatch.js";
import {
  buildPoolSignature,
  poolEspFromSmartleadType,
} from "../lib/poolSignature.js";
import { addDaysIsoDate } from "../services/remediation.js";
import { isExcluded } from "../services/campaignTopUp.js";
import type {
  PoolMailboxRecord,
  StateStore,
} from "../state/store.js";

export interface RotationPreview {
  allowed: boolean;
  email: string;
  reasons: string[];
  originalAccountId?: number;
  platform?: "GOOGLE" | "MICROSOFT";
  campaigns: Array<{ id: number; name: string; clientId: number | null }>;
  replacement?: {
    email: string;
    accountId: number;
    firstName: string;
    lastName: string;
  };
  clientId?: number | null;
  clientName?: string;
  holdUntil?: string;
}

export interface RotationResult {
  preview: RotationPreview;
  completed: boolean;
  rolledBack: boolean;
  errors: string[];
}

/**
 * Explicit, one-mailbox operation used by the employee console.
 *
 * It never buys/deletes anything and repeats every precondition immediately
 * before writing. A pool row is reserved as `provisioning`, and all completed
 * Smartlead campaign/identity writes are compensated on failure.
 */
export class ManualRotationService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async preview(rawEmail: string): Promise<RotationPreview> {
    const flipped = this.state.refreshPoolAvailability(
      this.config.poolWarmupDays,
    );
    if (flipped) await this.state.save();
    const email = rawEmail.trim().toLowerCase();
    const reasons: string[] = [];
    if (!email.includes("@")) reasons.push("A valid mailbox email is required.");
    if (!this.config.enableRecoveryPool) {
      reasons.push("Recovery pool is disabled.");
    }
    if (this.state.getPoolMailbox(email)) {
      reasons.push(
        "That mailbox is a generic pool sender. Operators may rotate client originals only.",
      );
    }
    if (this.state.getHeldInbox(email) || this.state.getSwap(email)) {
      reasons.push("That mailbox is already held or covered by an active swap.");
    }
    if (this.state.getRestingInbox(email)) {
      reasons.push("That mailbox is in its off-week rest and is not on live campaigns.");
    }

    const [campaigns, accounts, clients] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
    ]);
    const account = accounts.find(
      (candidate) => accountEmail(candidate)?.toLowerCase() === email,
    );
    if (!account) {
      reasons.push("Mailbox was not found in Smartlead.");
      return { allowed: false, email, reasons, campaigns: [] };
    }
    const extraGeneric = this.config.extraGenericMailboxes.some(
      (identifier) =>
        scoreNameMatch(identifier, {
          fromName: account.from_name,
          email: accountEmail(account),
        }).score >= MATCH_THRESHOLD,
    );
    if (extraGeneric) {
      reasons.push(
        "That mailbox belongs to the pre-warmed generic fleet, not a client original.",
      );
    }

    const activeCampaigns = campaigns
      .filter(
        (campaign) =>
          campaignIdsOf(account).includes(campaign.id) &&
          ["ACTIVE", "START"].includes(
            String(campaign.status ?? "").toUpperCase(),
          ),
      )
      .map((campaign) => ({
        id: campaign.id,
        name: String(campaign.name ?? campaign.id),
        clientId:
          typeof campaign.client_id === "number" ? campaign.client_id : null,
      }));
    if (!activeCampaigns.length) {
      reasons.push("Mailbox is not on an active campaign.");
    }
    const excludedCampaign = campaigns.find(
      (campaign) =>
        activeCampaigns.some((active) => active.id === campaign.id) &&
        isExcluded(campaign, this.config.topUpExcludeCampaigns),
    );
    if (excludedCampaign) {
      reasons.push(
        `Campaign #${excludedCampaign.id} ${excludedCampaign.name} is excluded from automatic mailbox changes.`,
      );
    }

    const clientIds = new Set(
      activeCampaigns
        .map((campaign) => campaign.clientId)
        .filter((id): id is number => id !== null),
    );
    if (clientIds.size > 1) {
      reasons.push(
        "Mailbox serves campaigns for multiple clients; one generic identity cannot safely replace it.",
      );
    }

    const platform = poolEspFromSmartleadType(account.type);
    if (!platform) reasons.push(`Unsupported Smartlead ESP type: ${account.type}`);

    const accountByEmail = new Map(
      accounts
        .map((row) => [accountEmail(row)?.toLowerCase(), row] as const)
        .filter(
          (row): row is [string, SmartleadAccountWithCampaigns] =>
            Boolean(row[0]),
        ),
    );
    const activeSwapPool = new Set(
      this.state.listActiveSwaps().map((swap) => swap.poolEmail.toLowerCase()),
    );
    const replacement = platform
      ? this.state.listPoolMailboxes().find((pool) => {
          if (
            pool.status !== "available" ||
            pool.platform !== platform ||
            !pool.smartleadAccountId ||
            activeSwapPool.has(pool.email.toLowerCase())
          ) {
            return false;
          }
          const smartleadPool = accountByEmail.get(pool.email.toLowerCase());
          return Boolean(
            smartleadPool && campaignIdsOf(smartleadPool).length === 0,
          );
        })
      : undefined;
    if (!replacement) {
      reasons.push(
        platform
          ? `No idle, fully warmed ${platform} generic is available.`
          : "No compatible generic can be selected.",
      );
    }

    const clientsById = new Map(clients.map((client) => [client.id, client]));
    const campaignClientById = new Map(
      campaigns.map((campaign) => [campaign.id, campaign.client_id]),
    );
    const client = resolveAccountClient(
      account,
      campaignClientById,
      clientsById,
    );

    return {
      allowed: reasons.length === 0,
      email,
      reasons,
      originalAccountId: account.id,
      platform: platform ?? undefined,
      campaigns: activeCampaigns,
      replacement: replacement?.smartleadAccountId
        ? {
            email: replacement.email,
            accountId: replacement.smartleadAccountId,
            firstName: replacement.firstName,
            lastName: replacement.lastName,
          }
        : undefined,
      clientId: client.clientId,
      clientName: client.clientName,
      holdUntil: addDaysIsoDate(new Date(), this.config.recoveryHoldDays),
    };
  }

  async execute(rawEmail: string): Promise<RotationResult> {
    const preview = await this.preview(rawEmail);
    const result: RotationResult = {
      preview,
      completed: false,
      rolledBack: false,
      errors: [],
    };
    if (
      !preview.allowed ||
      !preview.originalAccountId ||
      !preview.replacement ||
      !preview.platform ||
      !preview.holdUntil
    ) {
      return result;
    }

    const poolSnapshot = this.state.getPoolMailbox(
      preview.replacement.email,
    );
    if (!poolSnapshot || poolSnapshot.status !== "available") {
      result.preview.allowed = false;
      result.preview.reasons.push(
        "Replacement was claimed by another operation; preview again.",
      );
      return result;
    }

    const poolAccount = await this.smartlead.getEmailAccount(
      preview.replacement.accountId,
      { fetchCampaigns: true },
    );
    if (campaignIdsOf(poolAccount).length > 0) {
      this.state.upsertPoolMailbox(poolSnapshot);
      await this.state.save();
      result.preview.allowed = false;
      result.preview.reasons.push(
        "Replacement is no longer idle in Smartlead; preview again.",
      );
      return result;
    }
    const originalPoolIdentity = {
      signature: poolAccount.signature ?? "",
      from_name:
        poolAccount.from_name ??
        `${poolSnapshot.firstName} ${poolSnapshot.lastName}`,
      client_id: poolAccount.client_id ?? null,
    };

    // Reserve before any remote writes so cron/top-up cannot claim it.
    this.state.upsertPoolMailbox({
      ...poolSnapshot,
      status: "provisioning",
      assignedToEmail: preview.email,
      assignedAt: new Date().toISOString(),
    });
    try {
      await this.state.save();
    } catch (error) {
      this.state.upsertPoolMailbox(poolSnapshot);
      throw error;
    }

    const addedPool: number[] = [];
    const removedOriginal: number[] = [];
    let holdTag: { id: number; name: string } | null = null;
    let holdAssigned = false;
    let warmupAttempted = false;
    let remediationKey: string | null = null;
    try {
      holdTag = await this.smartlead.ensureHoldUntilTag(preview.holdUntil);
      await this.smartlead.setDailySendLimit(
        preview.replacement.accountId,
        this.config.messagePerDay,
      );
      await this.smartlead.updateEmailAccount(preview.replacement.accountId, {
        time_to_wait_in_mins: this.config.mailboxMinTimeGapMins,
      });

      const brand =
        (preview.clientName ?? "Unassigned / Agency")
          .replace(/\s*\(.*?\)\s*$/, "")
          .trim() || "Unassigned / Agency";
      await this.smartlead.updateEmailAccount(preview.replacement.accountId, {
        signature: buildPoolSignature({
          firstName: preview.replacement.firstName,
          lastName: preview.replacement.lastName,
          clientBrand: brand,
        }),
        from_name: `${preview.replacement.firstName} ${preview.replacement.lastName}`,
        client_id: preview.clientId ?? null,
      });

      // Add replacement before removing original: campaign headcount never
      // drops, and every subsequent write is compensated on failure.
      for (const campaign of preview.campaigns) {
        await this.smartlead.addEmailAccountsToCampaign(campaign.id, [
          preview.replacement.accountId,
        ]);
        addedPool.push(campaign.id);
        await sleep(200);
      }
      for (const campaign of preview.campaigns) {
        await this.smartlead.removeEmailAccountsFromCampaign(campaign.id, [
          preview.originalAccountId,
        ]);
        removedOriginal.push(campaign.id);
        await sleep(200);
      }
      await this.smartlead.assignTags(
        [preview.originalAccountId],
        [holdTag.id],
      );
      holdAssigned = true;
      warmupAttempted = true;
      await this.smartlead.configureWarmup(preview.originalAccountId, {
        warmup_enabled: true,
        total_warmup_per_day: this.config.warmupTotalPerDay,
        daily_rampup: this.config.warmupDailyRampup,
        reply_rate_percentage: this.config.warmupReplyRatePercentage,
      });

      const swappedAt = new Date().toISOString();
      this.state.markHeldInbox({
        accountId: preview.originalAccountId,
        email: preview.email,
        heldAt: swappedAt,
        holdUntil: preview.holdUntil,
        tagName: holdTag.name,
        removedFromCampaigns: preview.campaigns.map((campaign) => campaign.id),
      });
      remediationKey = `manual-rotate:${preview.email}:${swappedAt.slice(0, 10)}`;
      this.state.markRemediation(remediationKey);
      this.state.markSwap({
        originalEmail: preview.email,
        originalAccountId: preview.originalAccountId,
        poolEmail: preview.replacement.email,
        poolAccountId: preview.replacement.accountId,
        clientId: preview.clientId ?? null,
        clientName: preview.clientName ?? "Unassigned / Agency",
        campaignIds: preview.campaigns.map((campaign) => campaign.id),
        swappedAt,
        originalEsp: preview.platform,
        poolPlatform: preview.platform,
      });
      await this.state.save();
      result.completed = true;

      await this.slack
        .send(
          [
            "*Manual mailbox rotation completed*",
            `Operator moved \`${preview.email}\` to warmup until ${preview.holdUntil}.`,
            `Replacement: \`${preview.replacement.email}\` (${preview.platform}).`,
            `Campaigns: ${preview.campaigns.map((campaign) => `#${campaign.id}`).join(", ")}`,
          ].join("\n"),
        )
        .catch((error) =>
          console.warn("[ops-rotate] Slack notify failed", error),
        );
      return result;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      const rollbackErrors: string[] = [];
      for (const campaignId of removedOriginal) {
        try {
          await this.smartlead.addEmailAccountsToCampaign(campaignId, [
            preview.originalAccountId,
          ]);
        } catch (rollbackError) {
          rollbackErrors.push(
            `restore original to #${campaignId}: ${
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError)
            }`,
          );
        }
      }
      for (const campaignId of addedPool) {
        try {
          await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
            preview.replacement.accountId,
          ]);
        } catch (rollbackError) {
          rollbackErrors.push(
            `remove replacement from #${campaignId}: ${
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError)
            }`,
          );
        }
      }
      if (holdAssigned && holdTag) {
        try {
          await this.smartlead.removeTags(
            [preview.originalAccountId],
            [holdTag.id],
          );
        } catch (rollbackError) {
          rollbackErrors.push(
            `remove hold tag: ${
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError)
            }`,
          );
        }
      }
      if (warmupAttempted) {
        try {
          await this.smartlead.configureWarmup(preview.originalAccountId, {
            warmup_enabled: false,
            total_warmup_per_day: this.config.warmupTotalPerDay,
            daily_rampup: this.config.warmupDailyRampup,
            reply_rate_percentage: this.config.warmupReplyRatePercentage,
          });
        } catch (rollbackError) {
          rollbackErrors.push(
            `disable original warmup: ${
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError)
            }`,
          );
        }
      }
      try {
        await this.smartlead.updateEmailAccount(
          preview.replacement.accountId,
          originalPoolIdentity,
        );
      } catch (rollbackError) {
        rollbackErrors.push(
          `restore replacement identity: ${
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError)
          }`,
        );
      }
      this.state.clearSwap(preview.email);
      this.state.clearHeldInbox(preview.email);
      if (remediationKey) this.state.clearRemediation(remediationKey);
      this.state.upsertPoolMailbox(poolSnapshot);
      await this.state.save();
      result.rolledBack = rollbackErrors.length === 0;
      result.errors.push(...rollbackErrors);
      return result;
    }
  }

  /**
   * Recover a reservation left by a process crash. An idle mailbox can be
   * released automatically; one attached to a campaign stays quarantined and
   * alerts because guessing could duplicate or steal a live sender.
   */
  async recoverStaleReservations(
    maxAgeMs = 15 * 60 * 1000,
  ): Promise<{ released: string[]; quarantined: string[] }> {
    const released: string[] = [];
    const quarantined: string[] = [];
    const now = Date.now();
    for (const row of this.state.listPoolMailboxes()) {
      if (
        row.status !== "provisioning" ||
        !row.assignedToEmail ||
        !row.smartleadAccountId
      ) {
        continue;
      }
      const reservedAt = Date.parse(row.assignedAt ?? "");
      if (Number.isFinite(reservedAt) && now - reservedAt < maxAgeMs) continue;
      try {
        const account = await this.smartlead.getEmailAccount(
          row.smartleadAccountId,
          { fetchCampaigns: true },
        );
        if (campaignIdsOf(account).length === 0) {
          this.state.upsertPoolMailbox({
            ...row,
            status: "available",
            assignedToEmail: undefined,
            assignedAt: undefined,
            assignedClientId: undefined,
            assignedClientName: undefined,
          });
          released.push(row.email);
        } else {
          quarantined.push(row.email);
        }
      } catch {
        quarantined.push(row.email);
      }
    }
    if (released.length) await this.state.save();
    if (quarantined.length) {
      await this.slack
        .send(
          [
            "*Ops rotation needs review*",
            `${quarantined.length} generic reservation(s) survived a restart and are attached or could not be verified:`,
            ...quarantined.slice(0, 10).map((email) => `• \`${email}\``),
            "They remain quarantined (`provisioning`) and will not be reused automatically.",
          ].join("\n"),
        )
        .catch((error) =>
          console.warn("[ops-rotate] stale reservation alert failed", error),
        );
    }
    return { released, quarantined };
  }
}
