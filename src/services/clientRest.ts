import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SmartDeliveryClient } from "../clients/smartdelivery.js";
import {
  normalizeTestList,
  parseSenderInboxRates,
  testIdOf,
} from "../clients/smartdelivery.js";
import { isClientInboxEmail } from "../lib/clientInbox.js";
import {
  cohortForEmail,
  restingCohortForDate,
  type RestCohort,
} from "../lib/restCohort.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";

/**
 * D39 — Weekly 66/33 client-inbox rest.
 *
 * Rest = MESSAGE_PER_DAY 0 (warmup stays on). Mailboxes remain on every
 * same-client ACTIVE campaign so SmartDelivery keeps testing them. A resting
 * inbox returns to the normal send cap only when its same-ESP inbox rate is
 * ≥ REST_RESTORE_SAME_ESP_THRESHOLD (90).
 */

export interface ClientRestResult {
  dryRun: boolean;
  restingCohort: RestCohort;
  scannedClientInboxes: number;
  putToRest: string[];
  restored: Array<{ email: string; sameEspInbox: number }>;
  keptResting: number;
  errors: string[];
}

export class ClientRestService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<ClientRestResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const restingCohort = restingCohortForDate();
    const result: ClientRestResult = {
      dryRun,
      restingCohort,
      scannedClientInboxes: 0,
      putToRest: [],
      restored: [],
      keptResting: 0,
      errors: [],
    };

    if (!this.config.enableClientRest) {
      console.log("[client-rest] Disabled (ENABLE_CLIENT_REST=false)");
      return result;
    }

    const [accounts, clients] = await Promise.all([
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: false }),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
    ]);
    const clientNameById = new Map(
      clients.map((c) => [c.id, clientDisplayName(c)]),
    );

    const clientInboxes = (
      accounts as SmartleadAccountWithCampaigns[]
    ).filter((account) => {
      const email = accountEmail(account);
      if (!email || !account.id) return false;
      return isClientInboxEmail(email, {
        clientId: account.client_id,
        config: this.config,
        state: this.state,
      });
    });
    result.scannedClientInboxes = clientInboxes.length;

    const sameEspByEmail = await this.loadSameEspRates().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`same-ESP lookup: ${message}`);
      return new Map<string, number>();
    });

    const restoreAt = this.config.restRestoreSameEspThreshold;
    const nowIso = new Date().toISOString();

    for (const account of clientInboxes) {
      const email = accountEmail(account)!;
      const accountId = account.id!;
      const clientId = account.client_id as number;
      const cohort = cohortForEmail(email);
      const shouldRestThisWeek = cohort === restingCohort;
      const existing = this.state.getRestingInbox(email);
      const sameEsp = sameEspByEmail.get(email.toLowerCase());

      try {
        if (shouldRestThisWeek) {
          if (!existing) {
            if (!dryRun) {
              await this.smartlead.updateEmailAccount(accountId, {
                max_email_per_day: 0,
              });
              this.state.markRestingInbox({
                accountId,
                email,
                clientId,
                clientName: clientNameById.get(clientId),
                cohort,
                restingSince: nowIso,
                lastSameEspInbox: sameEsp,
              });
              await sleep(150);
            }
            result.putToRest.push(email);
          } else {
            if (typeof sameEsp === "number") {
              this.state.markRestingInbox({
                ...existing,
                lastSameEspInbox: sameEsp,
              });
            }
            // Ensure send cap stays at 0 while resting (mailbox-settings also
            // respects resting state, but defend against drift).
            if (!dryRun) {
              await this.smartlead.updateEmailAccount(accountId, {
                max_email_per_day: 0,
              });
              await sleep(150);
            }
            result.keptResting += 1;
          }
          continue;
        }

        // Live week for this cohort — restore only with enough same-ESP proof.
        if (existing) {
          const score =
            typeof sameEsp === "number"
              ? sameEsp
              : existing.lastSameEspInbox;
          if (typeof score === "number" && score >= restoreAt) {
            if (!dryRun) {
              await this.smartlead.updateEmailAccount(accountId, {
                max_email_per_day: this.config.messagePerDay,
              });
              this.state.clearRestingInbox(email);
              await sleep(150);
            }
            result.restored.push({ email, sameEspInbox: score });
          } else {
            if (typeof sameEsp === "number") {
              this.state.markRestingInbox({
                ...existing,
                lastSameEspInbox: sameEsp,
              });
            }
            result.keptResting += 1;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${email}: ${message}`);
      }
    }

    // Drop state rows for mailboxes that no longer look like client inboxes.
    for (const row of this.state.listRestingInboxes()) {
      const still = clientInboxes.some(
        (a) => accountEmail(a)?.toLowerCase() === row.email.toLowerCase(),
      );
      if (!still) this.state.clearRestingInbox(row.email);
    }

    console.log(
      `[client-rest] cohort=${restingCohort} scanned=${result.scannedClientInboxes} toRest=${result.putToRest.length} restored=${result.restored.length} kept=${result.keptResting} errors=${result.errors.length}`,
    );

    if (
      result.putToRest.length ||
      result.restored.length ||
      result.errors.length
    ) {
      await this.slack
        .notifyClientRest({
          restingCohort,
          putToRest: result.putToRest.length,
          restored: result.restored.length,
          keptResting: result.keptResting,
          restoreThreshold: restoreAt,
          errors: result.errors,
        })
        .catch((error) =>
          console.warn("[client-rest] Slack notify failed", error),
        );
    }

    await this.state.save();
    return result;
  }

  private async loadSameEspRates(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const listed = normalizeTestList(
      await this.smartDelivery.listTests({}).catch(() => []),
    );
    const ids = listed
      .map((t) => testIdOf(t))
      .filter((id): id is string => Boolean(id))
      .slice(0, 40);

    const types = new Map<string, string>();
    const accounts = await this.smartlead
      .listAllEmailAccounts({ fetchCampaigns: false })
      .catch(() => [] as SmartleadAccountWithCampaigns[]);
    for (const account of accounts) {
      const email = accountEmail(account);
      if (!email) continue;
      const type = String(
        (account as { type?: string }).type ??
          (account as { email_account?: { type?: string } }).email_account
            ?.type ??
          "",
      );
      if (type) types.set(email.toLowerCase(), type);
    }

    for (const testId of ids) {
      try {
        const raw = await this.smartDelivery.getSenderAccountReport(testId);
        const rows = parseSenderInboxRates(raw, testId, {
          senderTypeByEmail: types,
          preferSameEsp: true,
          minSameEspSamples: this.config.minSameEspSamples,
        });
        for (const row of rows) {
          if (row.scoredSameEsp !== true) continue;
          const key = row.email.toLowerCase();
          const prev = out.get(key);
          // Keep the worse same-ESP rate — restore needs ≥90, so be conservative.
          if (prev === undefined || row.inboxRate < prev) {
            out.set(key, row.inboxRate);
          }
        }
      } catch {
        // Best-effort across tests; restore waits if evidence is thin.
      }
      await sleep(100);
    }
    return out;
  }
}
