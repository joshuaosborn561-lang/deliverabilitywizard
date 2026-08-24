import type { AppConfig } from "../config.js";
import type { InboxKitClient } from "../clients/inboxkit.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import {
  genericIdentityClearFields,
  genericStillOnLiveCampaigns,
  isGenericForOwnership,
  sendingDomainOf,
} from "../lib/clientOwnership.js";
import {
  expectedClientForDomain,
  matchRuleByDomain,
  matchRuleByWorkspaceName,
} from "../lib/clientWorkspace.js";
import { parsePersonName } from "../lib/poolSignature.js";
import { isRetiredSendingDomain } from "../lib/domainControl.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";

export interface OwnershipFix {
  email: string;
  accountId: number;
  action: "set_client" | "clear_generic";
  fromClientId: number | null;
  toClientId: number | null;
  reason: string;
}

export interface WorkspaceFinding {
  domain: string;
  workspaceId: string;
  workspaceName?: string;
  expectedKind?: string;
  expectedClient?: string;
  issue: string;
}

export interface ClientOwnershipAuditResult {
  dryRun: boolean;
  examinedAccounts: number;
  examinedDomains: number;
  applied: OwnershipFix[];
  skipped: string[];
  workspaceFindings: WorkspaceFinding[];
  missingInSmartlead: Array<{ domain: string; expectedClient?: string }>;
  errors: string[];
}

export class ClientOwnershipService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly inboxkit: InboxKitClient | null,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async reconcileSmartlead(opts: {
    dryRun?: boolean;
    accounts?: SmartleadAccountWithCampaigns[];
    campaigns?: SmartleadCampaign[];
    clients?: SmartleadClientRecord[];
  } = {}): Promise<ClientOwnershipAuditResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: ClientOwnershipAuditResult = {
      dryRun,
      examinedAccounts: 0,
      examinedDomains: 0,
      applied: [],
      skipped: [],
      workspaceFindings: [],
      missingInSmartlead: [],
      errors: [],
    };

    const [accounts, campaigns, clients] = await Promise.all([
      opts.accounts
        ? Promise.resolve(opts.accounts)
        : this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      opts.campaigns
        ? Promise.resolve(opts.campaigns)
        : this.smartlead.listCampaigns(),
      opts.clients
        ? Promise.resolve(opts.clients)
        : this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
    ]);

    const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
    const canaryDomains = this.state.getCopyCanaryFleet()?.domains ?? [];
    result.examinedAccounts = accounts.length;

    for (const account of accounts) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;
      const domain = sendingDomainOf(email);
      const current =
        typeof account.client_id === "number" && Number.isFinite(account.client_id)
          ? account.client_id
          : null;
      const generic = isGenericForOwnership(account, email, this.config, this.state, {
        copyCanaryDomains: canaryDomains,
        isolationDomain: this.config.isolationDomain,
      });

      if (generic) {
        const live = genericStillOnLiveCampaigns(campaignIdsOf(account), campaignById);
        if (live) {
          result.skipped.push(`${email}: generic sending — keep client_id ${current ?? "none"}`);
          continue;
        }
        if (current == null) continue;
        const person = parsePersonName(account.from_name);
        const fields = genericIdentityClearFields(person.firstName, person.lastName);
        const fix: OwnershipFix = {
          email,
          accountId: account.id,
          action: "clear_generic",
          fromClientId: current,
          toClientId: null,
          reason: "generic is not sending for a client — take client_id off",
        };
        try {
          if (!dryRun) {
            await this.smartlead.updateEmailAccount(account.id, fields);
            await sleep(120);
          }
          result.applied.push(fix);
        } catch (error) {
          result.errors.push(
            `${email}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }

      const expected = expectedClientForDomain(domain, clients);
      if (!expected) {
        if (current == null) {
          result.skipped.push(`${email}: client domain with no name match — leave`);
        }
        continue;
      }
      if (current === expected.id) continue;
      const rule = matchRuleByDomain(domain);
      if (rule?.kind === "wiped") {
        result.skipped.push(`${email}: wiped-client leftover — do not re-tie`);
        continue;
      }
      const fix: OwnershipFix = {
        email,
        accountId: account.id,
        action: "set_client",
        fromClientId: current,
        toClientId: expected.id,
        reason: `${domain} belongs to ${expected.name ?? expected.id}`,
      };
      try {
        if (!dryRun) {
          await this.smartlead.updateEmailAccount(account.id, {
            client_id: expected.id,
          });
          await sleep(120);
        }
        result.applied.push(fix);
      } catch (error) {
        result.errors.push(
          `${email}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    console.log(
      `[ownership] Smartlead reconcile examined=${result.examinedAccounts} applied=${result.applied.length} errors=${result.errors.length}`,
    );
    return result;
  }

  async auditInboxKit(opts: {
    dryRun?: boolean;
  } = {}): Promise<ClientOwnershipAuditResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result = await this.reconcileSmartlead({ dryRun });
    if (!this.inboxkit) {
      result.errors.push("InboxKit is not configured — workspace audit skipped");
      return result;
    }

    const [clients, accounts] = await Promise.all([
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: false }),
    ]);
    const smartleadDomains = new Set(
      accounts
        .map((account) => sendingDomainOf(accountEmail(account) ?? ""))
        .filter(Boolean),
    );

    let workspaces: Array<{ uid?: string; id?: string; name?: string }> = [];
    try {
      workspaces = await this.inboxkit.listWorkspaces();
    } catch (error) {
      result.errors.push(
        `list workspaces: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }

    for (const workspace of workspaces) {
      const workspaceId = workspace.uid || workspace.id;
      if (!workspaceId) continue;
      const workspaceName = workspace.name;
      const workspaceRule = matchRuleByWorkspaceName(workspaceName);
      let domains: Array<{ name?: string; domain?: string }> = [];
      try {
        domains = await this.inboxkit.listDomains(workspaceId, { limit: 200 });
      } catch (error) {
        result.errors.push(
          `${workspaceName ?? workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      for (const row of domains) {
        const domain = (row.name || row.domain || "").toLowerCase();
        if (!domain) continue;
        result.examinedDomains += 1;
        const domainRule = matchRuleByDomain(domain);
        const expectedClient = expectedClientForDomain(domain, clients);
        const retired = isRetiredSendingDomain(
          domain,
          this.state.getDomainHistory(domain),
        );

        if (domainRule?.kind === "wiped" || workspaceRule?.kind === "wiped") {
          result.workspaceFindings.push({
            domain,
            workspaceId,
            workspaceName,
            expectedKind: "wiped",
            issue: "Domain is on a wiped-client workspace (GXA / MSRS / Nieto) — do not reuse",
          });
          continue;
        }

        if (domainRule?.kind === "client" && workspaceRule?.kind === "generic") {
          result.workspaceFindings.push({
            domain,
            workspaceId,
            workspaceName,
            expectedKind: "client",
            expectedClient: expectedClient?.name,
            issue: `Client domain sits in the generic pool workspace — move to ${domainRule.key}`,
          });
        } else if (
          !domainRule &&
          workspaceRule?.kind === "client" &&
          this.isKnownGenericDomain(domain)
        ) {
          result.workspaceFindings.push({
            domain,
            workspaceId,
            workspaceName,
            expectedKind: "generic",
            issue: "Generic / fleet domain sits in a client InboxKit workspace",
          });
        } else if (
          domainRule?.kind === "client" &&
          workspaceRule?.kind === "client" &&
          domainRule.key !== workspaceRule.key
        ) {
          result.workspaceFindings.push({
            domain,
            workspaceId,
            workspaceName,
            expectedKind: "client",
            expectedClient: expectedClient?.name,
            issue: `${domain} looks like ${domainRule.key} but lives in ${workspaceRule.key}`,
          });
        }

        if (
          domainRule?.kind === "client" &&
          !smartleadDomains.has(domain) &&
          !retired
        ) {
          result.missingInSmartlead.push({
            domain,
            expectedClient: expectedClient?.name,
          });
        }
      }
    }

    console.log(
      `[ownership] InboxKit audit domains=${result.examinedDomains} workspaceIssues=${result.workspaceFindings.length} missingSmartlead=${result.missingInSmartlead.length}`,
    );
    return result;
  }

  private isKnownGenericDomain(domain: string): boolean {
    if (this.config.extraGenericDomains.some((row) => row.toLowerCase() === domain)) {
      return true;
    }
    if (this.state.getCopyCanaryFleet()?.domains.some((row) => row.toLowerCase() === domain)) {
      return true;
    }
    return this.state.listPoolMailboxes().some((row) => row.domain.toLowerCase() === domain);
  }
}

export function summarizeOwnership(result: ClientOwnershipAuditResult): string {
  const lines = [
    result.dryRun ? "Preview — inbox and workspace ownership" : "Inbox and workspace ownership",
    `${result.applied.length} SalesGlider client-id fix${result.applied.length === 1 ? "" : "es"}.`,
  ];
  if (result.workspaceFindings.length) {
    lines.push(
      `${result.workspaceFindings.length} InboxKit workspace issue${result.workspaceFindings.length === 1 ? "" : "s"} (not moved automatically).`,
    );
  }
  if (result.missingInSmartlead.length) {
    lines.push(
      `${result.missingInSmartlead.length} client domain${result.missingInSmartlead.length === 1 ? "" : "s"} in InboxKit but not yet in SalesGlider.`,
    );
  }
  return lines.join("\n");
}
