import { Resolver } from "node:dns/promises";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { accountEmail } from "../clients/smartlead.js";
import type { StateStore } from "../state/store.js";

const DNS_ALERT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const DNS_DEDUPE_INITIALIZED_KEY = "dns-alert:dedupe-v1";

/**
 * Standing DNS audit over every domain Smartlead actually sends from.
 *
 * A mailbox can be perfectly configured in Smartlead and still fail
 * authentication because its zone is missing a record. That gap is invisible
 * from inside Smartlead — it only shows up in DNS — so nothing in the app
 * noticed five live domains sending with no SPF record at all.
 *
 * This resolves the authoritative records directly rather than trusting any
 * provider's own status field.
 */

export type DnsIssue =
  | "unresolvable"
  | "no-spf"
  | "multiple-spf"
  | "spf-neutral-all"
  | "spf-no-all"
  | "no-dmarc"
  | "no-mx";

export interface DomainAudit {
  domain: string;
  mailboxes: number;
  issues: DnsIssue[];
  spf: string | null;
}

export interface DnsAuditResult {
  checked: number;
  clean: number;
  failing: DomainAudit[];
  /** Issues that block authentication outright, worth waking someone for. */
  critical: DomainAudit[];
}

const CRITICAL: ReadonlySet<DnsIssue> = new Set<DnsIssue>([
  "unresolvable",
  "no-spf",
  "multiple-spf",
]);

export function classifyDomain(
  domain: string,
  mailboxes: number,
  records: {
    txt: string[] | null;
    dmarc: string[] | null;
    mx: string[] | null;
  },
): DomainAudit {
  const issues: DnsIssue[] = [];

  if (records.txt === null) {
    return { domain, mailboxes, issues: ["unresolvable"], spf: null };
  }

  const spfs = records.txt.filter((r) => /^v=spf1/i.test(r));
  const spf = spfs[0] ?? null;

  if (spfs.length === 0) issues.push("no-spf");
  // More than one SPF record is a permerror under RFC 7208 - receivers stop
  // evaluating rather than picking one.
  if (spfs.length > 1) issues.push("multiple-spf");
  if (spf && /\?all\b/i.test(spf)) issues.push("spf-neutral-all");
  if (spf && !/[-~?+]all\b/i.test(spf)) issues.push("spf-no-all");
  if (!records.dmarc?.some((r) => /^v=DMARC1/i.test(r))) issues.push("no-dmarc");
  if (!records.mx?.length) issues.push("no-mx");

  return { domain, mailboxes, issues, spf };
}

export function isCritical(audit: DomainAudit): boolean {
  return audit.issues.some((i) => CRITICAL.has(i));
}

export function dnsAlertKey(audit: DomainAudit): string {
  return `dns-alert:${audit.domain.toLowerCase()}:${[...audit.issues]
    .sort()
    .join(",")}`;
}

export class DnsAuditService {
  private readonly resolver: Resolver;

  constructor(
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    /** Public resolvers, so we see what receivers see - not a local cache. */
    nameservers: string[] = ["8.8.8.8", "1.1.1.1"],
    private readonly concurrency = 8,
  ) {
    this.resolver = new Resolver();
    this.resolver.setServers(nameservers);
  }

  private async txt(name: string): Promise<string[] | null> {
    try {
      return (await this.resolver.resolveTxt(name)).map((parts) =>
        parts.join(""),
      );
    } catch {
      return null;
    }
  }

  private async mx(name: string): Promise<string[] | null> {
    try {
      return (await this.resolver.resolveMx(name)).map((r) => r.exchange);
    } catch {
      return null;
    }
  }

  async run(opts: { alert?: boolean } = {}): Promise<DnsAuditResult> {
    const accounts = await this.smartlead.listAllEmailAccounts({
      fetchCampaigns: false,
    });

    const counts = new Map<string, number>();
    for (const account of accounts) {
      const domain = accountEmail(account)?.toLowerCase().split("@")[1];
      if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }

    const domains = [...counts.keys()].sort();
    const audits: DomainAudit[] = [];
    let cursor = 0;

    const worker = async () => {
      while (cursor < domains.length) {
        const domain = domains[cursor++]!;
        const [txt, dmarc, mx] = await Promise.all([
          this.txt(domain),
          this.txt(`_dmarc.${domain}`),
          this.mx(domain),
        ]);
        audits.push(
          classifyDomain(domain, counts.get(domain) ?? 0, { txt, dmarc, mx }),
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, domains.length) }, worker),
    );

    const failing = audits
      .filter((a) => a.issues.length > 0)
      .sort((a, b) => b.mailboxes - a.mailboxes || a.domain.localeCompare(b.domain));
    const critical = failing.filter(isCritical);

    const result: DnsAuditResult = {
      checked: audits.length,
      clean: audits.length - failing.length,
      failing,
      critical,
    };

    console.log(
      `[dns-audit] ${result.checked} domains, ${result.clean} clean, ${failing.length} with issues, ${critical.length} critical`,
    );
    for (const a of failing) {
      console.log(`[dns-audit]   ${a.domain} (${a.mailboxes} mailboxes) ${a.issues.join(", ")}`);
    }

    if (opts.alert !== false && critical.length) {
      if (!this.state.hasAlert(DNS_DEDUPE_INITIALIZED_KEY)) {
        this.state.markAlert(DNS_DEDUPE_INITIALIZED_KEY);
        for (const audit of critical) {
          this.state.markAlert(dnsAlertKey(audit));
        }
        await this.state.save();
        console.log(
          `[dns-audit] initialized alert dedupe with ${critical.length} current critical condition(s); Slack suppressed`,
        );
      } else {
        const alertable = critical.filter(
          (audit) =>
            !this.state.hasRecentAlert(
              dnsAlertKey(audit),
              DNS_ALERT_COOLDOWN_MS,
            ),
        );
        if (alertable.length && (await this.alert(alertable))) {
          for (const audit of alertable) {
            this.state.markAlert(dnsAlertKey(audit));
          }
          await this.state.save();
        } else if (critical.length && !alertable.length) {
          console.log(
            `[dns-audit] suppressed ${critical.length} repeated critical alert(s) within 7-day cooldown`,
          );
        }
      }
    }
    return result;
  }

  private async alert(critical: DomainAudit[]): Promise<boolean> {
    const lines = critical
      .slice(0, 20)
      .map((a) => `- ${a.domain} (${a.mailboxes} mailboxes): ${a.issues.join(", ")}`);
    const more =
      critical.length > 20 ? `\n...and ${critical.length - 20} more` : "";
    const mailboxes = critical.reduce((sum, a) => sum + a.mailboxes, 0);

    try {
      await this.slack.send(
        [
          `DNS audit: ${critical.length} sending domain(s) cannot authenticate — ${mailboxes} mailbox(es) affected.`,
          ...lines,
          more,
          "",
          "These send mail but fail SPF at the receiver. Fix the zone in InboxKit.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return true;
    } catch (error) {
      console.warn("[dns-audit] Slack alert failed", error);
      return false;
    }
  }
}
