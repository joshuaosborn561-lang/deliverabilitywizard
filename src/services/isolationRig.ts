import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import { accountEmail, type SmartleadClient } from "../clients/smartlead.js";
import {
  parseSenderInboxRates,
  type SmartDeliveryClient,
} from "../clients/smartdelivery.js";
import { defaultControlTemplate } from "../lib/controlTemplate.js";
import {
  effectiveIsolationDomain,
  isIsolationEmail,
  normalizeIsolationDomain,
} from "../lib/isolationDomain.js";
import {
  buildIsolationAction,
  requestIsolationAction,
} from "../lib/isolationActions.js";
import { RIG_CONTROL_TEST_PREFIX, rigControlTestName } from "../lib/isolationNames.js";
import {
  controlSequence,
  isolationManualPayload,
} from "../lib/isolationPlacement.js";
import { placementFromInboxRate } from "../lib/mailboxControlTag.js";
import { resolveIsolationDenylist } from "../lib/resolveIsolationDenylist.js";
import type { StateStore } from "../state/store.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface IsolationRigResult {
  dryRun: boolean;
  configured: boolean;
  baselined: boolean;
  testId?: string;
  controlPrimary?: boolean;
  errors: string[];
}

export class IsolationRigService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async applyDenylist(): Promise<number[]> {
    const resolved = await resolveIsolationDenylist(
      this.config,
      this.smartlead,
      effectiveIsolationDomain(this.config, this.state),
    );
    this.smartlead.setIsolationDenylist(resolved.accountIds);
    if (resolved.domain || resolved.emails.length) {
      this.state.patchIsolation({
        isolationDomain: {
          domain: resolved.domain ?? "",
          mailboxIds: resolved.accountIds,
          emails: resolved.emails,
          status: resolved.accountIds.length ? "configured" : "failed",
          baselinedAt: this.state.getIsolation().isolationDomain?.baselinedAt,
          lastControlTestId:
            this.state.getIsolation().isolationDomain?.lastControlTestId,
          lastControlPrimary:
            this.state.getIsolation().isolationDomain?.lastControlPrimary,
        },
      });
    }
    return resolved.accountIds;
  }

  async run(opts: { dryRun?: boolean; force?: boolean } = {}): Promise<IsolationRigResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: IsolationRigResult = {
      dryRun,
      configured: false,
      baselined: false,
      errors: [],
    };

    if (!this.config.enableIsolationRig) return result;

    const domain = effectiveIsolationDomain(this.config, this.state);
    const emails = await this.rigEmails();
    if (!domain || emails.length < 1) {
      // D137 — an unarmed rig is a one-tap buy away, not a shrug. The ask
      // dedupes for the lifetime of the rig; Josh's tap is the approval
      // (D4/D60) and the buy runs the same spend-gated pipeline as a
      // replacement domain.
      await this.requestArm(domain);
      console.log(
        "[isolation-rig] not armed — the word hunt waits on the isolation-domain buy (D137)",
      );
      return result;
    }
    result.configured = true;

    const last = this.state.getIsolation().lastRigBaselineAt;
    const stale =
      !last || Date.now() - Date.parse(last) >= WEEK_MS || opts.force;
    if (!stale) {
      result.baselined = true;
      return result;
    }

    const template = defaultControlTemplate();
    if (dryRun) {
      result.testId = "dry-run-rig";
      return result;
    }

    try {
      const created = await this.smartDelivery.createManualPlacement(
        isolationManualPayload({
          testName: rigControlTestName(domain),
          description: `${RIG_CONTROL_TEST_PREFIX} weekly baseline ${template.controlVersion}`,
          senderAccounts: emails,
          sequence: controlSequence(template, "Rig control"),
          folderId: this.state.getIsolation().folders.teardowns,
          providerIds: this.config.providerIds,
          linkChecker: false,
        }),
      );
      result.testId = String(created.id);
      this.state.patchIsolation({
        lastRigBaselineAt: new Date().toISOString(),
        isolationDomain: {
          domain,
          mailboxIds: this.smartlead.isolationDenylistIds(),
          emails,
          status: "baselined",
          baselinedAt: new Date().toISOString(),
          lastControlTestId: result.testId,
        },
      });
      await this.state.save();
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
    return result;
  }

  async readLatestControl(): Promise<boolean | null> {
    const testId = this.state.getIsolation().isolationDomain?.lastControlTestId;
    if (!testId) return null;
    try {
      const raw = await this.smartDelivery.getSenderAccountReport(testId);
      const rates = parseSenderInboxRates(raw, testId, {
        preferSameEsp: false,
      });
      if (!rates.length) return null;
      const placements = rates.map((row) =>
        placementFromInboxRate({
          inboxRate: row.inboxRate,
          scoredSameEsp: true,
          requireSameEsp: false,
        }),
      );
      const primary = placements.every((placement) => placement === "PRIMARY");
      const domain = this.state.getIsolation().isolationDomain;
      if (domain) {
        this.state.patchIsolation({
          isolationDomain: { ...domain, lastControlPrimary: primary },
        });
      }
      return primary;
    } catch {
      return null;
    }
  }

  /** D137 — one owner ask to buy the rig's isolation domain, ever. */
  private async requestArm(existingDomain: string): Promise<void> {
    if (existingDomain) return; // domain known, only mailboxes missing — buy resume handles it
    await requestIsolationAction({
      store: this.state,
      slack: this.slack,
      action: buildIsolationAction({
        kind: "buy_isolation_domain",
        title: "Arm the word-hunt rig: buy its isolation domain",
        proof: [
          "The spam-word hunt needs one throwaway domain with a few mailboxes that never touch clients.",
          `One domain + ${this.config.isolationMailboxesPerBuyDomain} mailbox(es), bought through the normal approval flow — your tap is the approval, single-use, monthly caps apply (D4/D60).`,
          "Until it exists, copy verdicts stop at the word-hunt step (D93 still separates infra from copy).",
        ].join("\n"),
        detail: { quantity: 1, isolationRig: true },
      }),
    });
  }

  async rigEmails(): Promise<string[]> {
    const configured = new Set(this.config.isolationMailboxEmails);
    const domain = effectiveIsolationDomain(this.config, this.state);
    if (!domain && !configured.size) return [];
    const accounts = await this.smartlead.listAllEmailAccounts().catch(() => []);
    const emails: string[] = [];
    for (const account of accounts) {
      const email = accountEmail(account)?.toLowerCase();
      if (isIsolationEmail(email, { emails: configured, domain })) {
        emails.push(email!);
      }
    }
    return [...new Set(emails)];
  }
}
