import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  resolveAccountClient,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import {
  buildPoolSignature,
  parsePersonName,
  poolEspFromSmartleadType,
  resolvePoolEspFromDomain,
  type PoolEspDnsLookup,
} from "../lib/poolSignature.js";
import type { StateStore } from "../state/store.js";

export interface PoolSwapAction {
  originalEmail: string;
  originalAccountId: number;
  poolEmail: string;
  poolAccountId: number;
  clientName: string;
  campaignIds: number[];
  platform: "GOOGLE" | "MICROSOFT";
}

export interface PoolRestoreAction {
  originalEmail: string;
  poolEmail: string;
  campaignIds: number[];
  inboxRate: number;
}

export interface RecoveryPoolResult {
  dryRun: boolean;
  flippedAvailable: number;
  swaps: PoolSwapAction[];
  restores: PoolRestoreAction[];
  skippedNoPool: string[];
  errors: string[];
}

/**
 * Recovery pool: when a client inbox is pulled for low same-ESP inbox %,
 * sub in a warmed generic (matching ESP) with signature `First Last\\n{Brand}`.
 * When the original recovers ≥ threshold, swap back and free the generic.
 */
export class RecoveryPoolService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    /** Injectable for tests; production resolves MX/SPF via public DNS. */
    private readonly dnsLookup?: PoolEspDnsLookup,
  ) {}

  async run(opts: {
    accounts: SmartleadAccountWithCampaigns[];
    /** Emails just pulled this remediation pass (candidates for swap-in) */
    newlyHeld: Array<{
      accountId: number;
      email: string;
      removedFromCampaigns: number[];
      clientId?: number | null;
      clientName?: string;
      type?: string;
      fromName?: string;
    }>;
    /** Held emails that now score ≥ threshold (same-ESP) — swap originals back */
    recoveredOriginals: Array<{
      email: string;
      inboxRate: number;
    }>;
    dryRun: boolean;
    campaignClientById: Map<number, number | null | undefined>;
    clientsById: Map<number, SmartleadClientRecord>;
  }): Promise<RecoveryPoolResult> {
    const result: RecoveryPoolResult = {
      dryRun: opts.dryRun,
      flippedAvailable: 0,
      swaps: [],
      restores: [],
      skippedNoPool: [],
      errors: [],
    };

    if (!this.config.enableRecoveryPool) {
      return result;
    }

    result.flippedAvailable = this.state.refreshPoolAvailability(
      this.config.poolWarmupDays,
    );

    const byEmail = new Map(
      opts.accounts
        .map((a) => [accountEmail(a)?.toLowerCase(), a] as const)
        .filter((x): x is [string, SmartleadAccountWithCampaigns] => Boolean(x[0])),
    );

    // 1) Restore originals that recovered
    for (const row of opts.recoveredOriginals) {
      const swap = this.state.getSwap(row.email);
      if (!swap) continue;
      try {
        if (!opts.dryRun) {
          // Remove pool from campaigns, reattach original
          for (const campaignId of swap.campaignIds) {
            try {
              await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
                swap.poolAccountId,
              ]);
              await sleep(250);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              result.errors.push(
                `pool remove ${swap.poolEmail} from ${campaignId}: ${message}`,
              );
            }
            try {
              await this.smartlead.addEmailAccountsToCampaign(campaignId, [
                swap.originalAccountId,
              ]);
              await sleep(250);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              result.errors.push(
                `reattach original ${swap.originalEmail} → ${campaignId}: ${message}`,
              );
            }
          }
          // Clear branded signature on pool generic
          try {
            const poolMeta = this.state.getPoolMailbox(swap.poolEmail);
            const poolAcc = byEmail.get(swap.poolEmail.toLowerCase());
            const { firstName, lastName } = parsePersonName(
              poolAcc?.from_name ||
                (poolMeta
                  ? `${poolMeta.firstName} ${poolMeta.lastName}`
                  : undefined),
            );
            await this.smartlead.updateEmailAccount(swap.poolAccountId, {
              signature: `${firstName} ${lastName}`,
              from_name: `${firstName} ${lastName}`,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            result.errors.push(`clear pool signature ${swap.poolEmail}: ${message}`);
          }
          this.state.clearSwap(swap.originalEmail);
          this.state.clearHeldInbox(swap.originalEmail);
          this.state.clearInboxRemediation(swap.originalEmail);
        }
        result.restores.push({
          originalEmail: swap.originalEmail,
          poolEmail: swap.poolEmail,
          campaignIds: swap.campaignIds,
          inboxRate: row.inboxRate,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`restore swap ${row.email}: ${message}`);
      }
    }

    // 2) Assign pool generics for newly held inboxes (ESP-matched)
    for (const held of opts.newlyHeld) {
      const email = held.email.toLowerCase();
      if (this.state.getSwap(email)) continue;
      if (!held.removedFromCampaigns.length) continue;

      const account = byEmail.get(email);
      const rawType = held.type ?? account?.type;
      let platform = poolEspFromSmartleadType(rawType) ?? null;
      // Smartlead marks many Workspace/M365 mailboxes as SMTP when they use
      // custom SMTP/IMAP rather than OAuth. Infer ESP from the domain's MX/SPF
      // so recovery swaps still ESP-match (e.g. useroofsbypeterson.info → Google).
      if (!platform) {
        const domain = email.split("@")[1] ?? "";
        platform = domain
          ? await resolvePoolEspFromDomain(domain, this.dnsLookup)
          : null;
      }
      if (!platform) {
        result.errors.push(
          `swap ${email}: unknown ESP type (${rawType ?? "n/a"})`,
        );
        continue;
      }

      const pool = this.state.findAvailablePoolMailbox(platform);
      if (!pool || !pool.smartleadAccountId) {
        // Include ESP so Slack can say "no free Google generic" plainly.
        result.skippedNoPool.push(`${email} (${platform})`);
        continue;
      }

      const client =
        held.clientId !== undefined
          ? {
              clientId: held.clientId ?? null,
              clientName: held.clientName || "Unassigned / Agency",
            }
          : account
            ? resolveAccountClient(
                account,
                opts.campaignClientById,
                opts.clientsById,
              )
            : { clientId: null, clientName: "Unassigned / Agency" };

      const brand =
        client.clientName.replace(/\s*\(.*?\)\s*$/, "").trim() ||
        client.clientName;
      const person = parsePersonName(
        held.fromName ??
          account?.from_name ??
          `${pool.firstName} ${pool.lastName}`,
      );
      // Prefer the pool mailbox's own first/last for the visible sender line
      const firstName = pool.firstName || person.firstName;
      const lastName = pool.lastName || person.lastName;
      const signature = buildPoolSignature({
        firstName,
        lastName,
        clientBrand: brand,
      });

      try {
        if (!opts.dryRun) {
          await this.smartlead.updateEmailAccount(pool.smartleadAccountId, {
            signature,
            from_name: `${firstName} ${lastName}`,
            ...(client.clientId != null ? { client_id: client.clientId } : {}),
          });
          await sleep(200);

          for (const campaignId of held.removedFromCampaigns) {
            await this.smartlead.addEmailAccountsToCampaign(campaignId, [
              pool.smartleadAccountId,
            ]);
            await sleep(300);
          }
        }

        const swapAt = new Date().toISOString();
        if (!opts.dryRun) {
          this.state.markSwap({
            originalEmail: email,
            originalAccountId: held.accountId,
            poolEmail: pool.email.toLowerCase(),
            poolAccountId: pool.smartleadAccountId,
            clientId: client.clientId,
            clientName: client.clientName,
            campaignIds: held.removedFromCampaigns,
            swappedAt: swapAt,
            originalEsp: held.type ?? account?.type,
            poolPlatform: platform,
          });
        }

        result.swaps.push({
          originalEmail: email,
          originalAccountId: held.accountId,
          poolEmail: pool.email.toLowerCase(),
          poolAccountId: pool.smartleadAccountId,
          clientName: client.clientName,
          campaignIds: held.removedFromCampaigns,
          platform,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`swap-in ${email} ← ${pool.email}: ${message}`);
      }
    }

    if (result.swaps.length || result.restores.length || result.skippedNoPool.length) {
      await this.notify(result).catch((error) => {
        console.error("[recovery-pool] Slack notify failed", error);
      });
    }

    console.log("[recovery-pool] Done", {
      dryRun: result.dryRun,
      flippedAvailable: result.flippedAvailable,
      swaps: result.swaps.length,
      restores: result.restores.length,
      skippedNoPool: result.skippedNoPool.length,
      errors: result.errors.length,
    });

    return result;
  }

  private async notify(result: RecoveryPoolResult): Promise<void> {
    const lines = [
      `*Recovery pool* (${result.dryRun ? "DRY RUN" : "LIVE"})`,
      result.swaps.length
        ? `• Swapped in ${result.swaps.length} generic(s)`
        : null,
      ...result.swaps.slice(0, 8).map(
        (s) =>
          `  – \`${s.originalEmail}\` → \`${s.poolEmail}\` (${s.platform}, ${s.clientName})`,
      ),
      result.restores.length
        ? `• Restored ${result.restores.length} original(s)`
        : null,
      ...result.restores.slice(0, 8).map(
        (r) =>
          `  – \`${r.originalEmail}\` back (pool \`${r.poolEmail}\` freed) @ ${r.inboxRate.toFixed(1)}%`,
      ),
      result.skippedNoPool.length
        ? `• Couldn't cover these — no free warmed generic of the right type (Gmail/Microsoft) is available yet:\n${result.skippedNoPool
            .slice(0, 5)
            .map((e) => `  – \`${e}\``)
            .join("\n")}`
        : null,
    ].filter(Boolean);
    if (lines.length <= 1) return;
    await this.slack.send(lines.join("\n"));
  }
}
