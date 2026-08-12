import {
  humanizeAlertError,
  isBenignOpsNoise,
  isRateLimitNoise,
} from "../lib/alertNoise.js";
import {
  formatExecBriefing,
  type ExecBriefingInput,
} from "../lib/execBriefing.js";

export interface SlackCredentials {
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
  channelLabel: string;
}

export class SlackClient {
  constructor(private readonly creds: SlackCredentials) {}

  async send(text: string, blocks?: unknown[]): Promise<void> {
    if (this.creds.botToken) {
      await this.sendViaBot(text, blocks);
      return;
    }
    if (this.creds.webhookUrl) {
      await this.sendViaWebhook(text, blocks);
      return;
    }
    throw new Error(
      "Slack is not configured. Set SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN (+ SLACK_CHANNEL_ID).",
    );
  }

  private async sendViaWebhook(text: string, blocks?: unknown[]): Promise<void> {
    const payload: Record<string, unknown> = {
      text,
      username: "Deliverability Wizard",
      icon_emoji: ":mailbox_with_mail:",
    };
    if (blocks?.length) payload.blocks = blocks;

    const response = await fetch(this.creds.webhookUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Slack webhook failed (${response.status}): ${body}`);
    }
  }

  private async sendViaBot(text: string, blocks?: unknown[]): Promise<void> {
    const channel = this.creds.channelId || this.creds.channelLabel;
    if (!channel) {
      throw new Error("SLACK_CHANNEL_ID (or SLACK_CHANNEL) is required with SLACK_BOT_TOKEN");
    }

    const payload: Record<string, unknown> = {
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
    };
    if (blocks?.length) payload.blocks = blocks;

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.creds.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });

    const body = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || !body.ok) {
      throw new Error(
        `Slack chat.postMessage failed: ${body.error || `HTTP ${response.status}`}`,
      );
    }
  }

  /** High-level Done / Needs attention / Quiet briefing for Josh. */
  async notifyExecBriefing(input: ExecBriefingInput): Promise<void> {
    await this.send(formatExecBriefing(input));
  }

  async notifyQuotaBlocked(details: {
    used: number;
    quota: number;
    needed: number;
    campaigns: Array<{ id: number; name: string; testsNeeded: number }>;
  }): Promise<void> {
    const lines = details.campaigns
      .map(
        (c) =>
          `• *${c.name}* — needs ${c.testsNeeded} test${c.testsNeeded === 1 ? "" : "s"}`,
      )
      .join("\n");

    await this.send(
      [
        `*Couldn't create placement tests — monthly quota is full*`,
        `Used ${details.used} of ${details.quota}. This batch needed ${details.needed} more.`,
        `Nothing was created. Free quota or skip a campaign, then re-run.`,
        lines || undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async notifyRunSummary(summary: {
    scanned: number;
    eligible: number;
    created: number;
    skipped: number;
    errors: string[];
  }): Promise<void> {
    // Quiet when nothing happened
    if (
      summary.created === 0 &&
      summary.eligible === 0 &&
      summary.errors.length === 0
    ) {
      return;
    }

    const lines = [
      `*Placement test scan*`,
      `Looked at ${summary.scanned} campaigns.`,
    ];
    if (summary.created > 0) {
      lines.push(
        `Created ${summary.created} new placement test${summary.created === 1 ? "" : "s"} for campaigns that didn't have one yet.`,
      );
    } else if (summary.eligible > 0) {
      lines.push(
        `Found ${summary.eligible} campaign${summary.eligible === 1 ? "" : "s"} that need tests, but none were created.`,
      );
    }
    if (summary.skipped > 0) {
      lines.push(`Skipped ${summary.skipped}.`);
    }
    const seriousErrors = summary.errors
      .filter((e) => !isRateLimitNoise(e))
      .map(humanizeAlertError);
    if (seriousErrors.length) {
      lines.push(
        "",
        `What went wrong:`,
        ...seriousErrors.slice(0, 8).map((e) => `• ${e}`),
      );
    }
    await this.send(lines.join("\n"));
  }

  async notifyBlacklist(details: {
    testId: string;
    testName?: string;
    domain: string;
    total?: number;
    ip?: string;
    fromEmail?: string;
  }): Promise<void> {
    await this.notifyBlacklistedDomains({
      testId: details.testId,
      testName: details.testName,
      domains: [details.domain],
      hits: [
        {
          domain: details.domain,
          fromEmail: details.fromEmail,
          source: details.ip ? "ip-blacklist" : "domain-blacklist",
          ip: details.ip,
          totalHits: details.total,
        },
      ],
    });
  }

  /**
   * Call out every blacklisted sending domain by name.
   */
  async notifyBlacklistedDomains(details: {
    testId: string;
    testName?: string;
    domains: string[];
    hits: Array<{
      domain: string;
      fromEmail?: string;
      source: "domain-blacklist" | "ip-blacklist";
      ip?: string;
      listName?: string;
      totalHits?: number;
      details?: string;
      seedEspHits?: string[];
    }>;
  }): Promise<void> {
    const domains = [...new Set(details.domains.map((d) => d.toLowerCase()))];
    if (!domains.length) return;

    const domainLines = domains.map((domain) => {
      const related = details.hits.filter(
        (h) => h.domain.toLowerCase() === domain,
      );
      const fromEmail =
        related.find((h) => h.fromEmail)?.fromEmail ?? undefined;
      return fromEmail
        ? `• *${domain}* (sender \`${fromEmail}\`)`
        : `• *${domain}*`;
    });

    await this.send(
      [
        `*Sending domain${domains.length === 1 ? "" : "s"} on a blacklist*`,
        details.testName
          ? `From test: *${details.testName}*`
          : `Test id: \`${details.testId}\``,
        "",
        ...domainLines,
        "",
        `I'll delete matching Smartlead accounts and purge the domain from InboxKit when remediation runs.`,
        `You'll need replacement domain(s) + mailboxes for that client — don't reuse these.`,
      ].join("\n"),
    );
  }

  /**
   * Blacklist alert that says *why* a domain is listed and whether the domain
   * is burned or we're stuck behind a dirty shared InboxKit IP.
   */
  async notifyBlacklistDiagnosis(details: {
    testId: string;
    testName?: string;
    diagnoses: Array<{
      domain: string;
      fromEmail?: string;
      verdict: string;
      reason: string;
      recommendation: string;
      listings: string[];
      ips: string[];
      sharedWithDomains: string[];
    }>;
  }): Promise<void> {
    if (!details.diagnoses.length) return;

    const burned = details.diagnoses.filter((d) => d.verdict === "domain_burned");
    const sharedIp = details.diagnoses.filter((d) => d.verdict === "shared_ip");

    const blocks: string[] = [
      `*Blacklisted sending domain${details.diagnoses.length === 1 ? "" : "s"}*`,
      details.testName
        ? `From test: *${details.testName}*`
        : `Test id: \`${details.testId}\``,
      "",
    ];

    for (const d of details.diagnoses) {
      const label =
        d.verdict === "domain_burned"
          ? ":skull: DOMAIN BURNED"
          : d.verdict === "shared_ip"
            ? ":warning: SHARED IP (InboxKit)"
            : d.verdict === "domain_ip"
              ? ":warning: IP LISTED"
              : ":grey_question: UNCLEAR";

      blocks.push(`${label} — *${d.domain}*`);
      if (d.fromEmail) blocks.push(`  sender: \`${d.fromEmail}\``);
      if (d.listings.length) {
        blocks.push(`  listed on: ${d.listings.join(", ")}`);
      }
      if (d.ips.length) blocks.push(`  IP: ${d.ips.join(", ")}`);
      if (d.sharedWithDomains.length) {
        blocks.push(
          `  same IP also serves: ${d.sharedWithDomains.slice(0, 6).join(", ")}`,
        );
      }
      blocks.push(`  why: ${d.reason}`);
      blocks.push(`  → ${d.recommendation}`);
      blocks.push("");
    }

    if (sharedIp.length) {
      blocks.push(
        `:rotating_light: ${sharedIp.length} of these are *shared-IP* listings — buying replacement domains will NOT fix them. Take the IP to InboxKit.`,
      );
    }
    if (burned.length) {
      blocks.push(
        `${burned.length} domain(s) are genuinely burned and will be replaced by remediation.`,
      );
    }

    await this.send(blocks.filter((x) => x !== undefined).join("\n"));
  }

  /**
   * Plain-English placement alert for a campaign test (one message per test).
   */
  async notifyLowDeliverability(details: {
    label: string;
    score: number;
    threshold: number;
    context?: string;
  }): Promise<void> {
    // Legacy single-row path — prefer notifyPlacementResult when possible.
    await this.notifyPlacementResult({
      testName: details.context?.replace(/^Test:\s*/i, "") || undefined,
      testId: undefined,
      threshold: details.threshold,
      providers: [{ name: details.label, inboxPercent: details.score }],
      autoRemediation: true,
    });
  }

  async notifyPlacementResult(details: {
    testName?: string;
    testId?: string;
    threshold: number;
    providers: Array<{ name: string; inboxPercent: number }>;
    /** When true, tell the user we're handling weak inboxes automatically */
    autoRemediation?: boolean;
    /** Overall inbox/tab/spam split for the whole test. */
    overall?: { inboxPercent: number; tabPercent: number; spamPercent: number };
    /** Per-sender placement, worst first. */
    senders?: Array<{
      email: string;
      inboxPercent: number;
      scoredSameEsp?: boolean;
      willRemediate?: boolean;
    }>;
    /** Senders whose SPF or DKIM is failing on every seed. */
    authFailures?: Array<{
      email: string;
      spfFailing: boolean;
      dkimFailing: boolean;
    }>;
    remediationThreshold?: number;
    holdDays?: number;
  }): Promise<void> {
    const weak = details.providers.filter(
      (p) => p.inboxPercent < details.threshold,
    );
    if (!weak.length) return;

    const outlook = weak.find((p) =>
      /outlook|office\s*365|o365|microsoft/i.test(p.name),
    );
    const gmail = weak.find((p) => /g\s*suite|gmail|google/i.test(p.name));

    let plainTake: string;
    if (outlook && outlook.inboxPercent < 20 && (!gmail || gmail.inboxPercent >= 50)) {
      plainTake =
        `Outlook/Microsoft is burying this campaign (mostly spam). Gmail is doing better. That pattern usually means the *copy/offer* is getting filtered on Microsoft — not one broken mailbox.`;
    } else if (
      weak.length >= 2 &&
      weak.every((p) => p.inboxPercent < 40)
    ) {
      plainTake =
        `Inbox rates are weak across providers. Could be the copy/offer, the domains, or both — not a single-inbox fluke.`;
    } else if (weak.length === 1) {
      plainTake = `*${weak[0]!.name}* is below ${details.threshold}% inbox on this test.`;
    } else {
      plainTake = `A few providers came in under ${details.threshold}% inbox on this test.`;
    }

    const scoreLines = details.providers.map(
      (p) =>
        `• *${p.name}*: ${p.inboxPercent.toFixed(1)}% inbox${
          p.inboxPercent < details.threshold ? " (below target)" : ""
        }`,
    );

    const overallLine = details.overall
      ? `Overall: *${details.overall.inboxPercent.toFixed(1)}% inbox* · ${details.overall.tabPercent.toFixed(1)}% tab · *${details.overall.spamPercent.toFixed(1)}% spam*`
      : undefined;

    // SPF/DKIM failures explain bad placement better than any sender score
    const authLines: string[] = [];
    const auth = details.authFailures ?? [];
    if (auth.length) {
      const spfBroken = auth.filter((a) => a.spfFailing);
      const dkimBroken = auth.filter((a) => a.dkimFailing);
      authLines.push("");
      if (spfBroken.length) {
        authLines.push(
          `:rotating_light: *SPF is FAILING on ${spfBroken.length} sender${spfBroken.length === 1 ? "" : "s"}* — this alone will push mail to spam regardless of copy or warmup. Fix the SPF record before replacing anything.`,
          ...spfBroken.slice(0, 8).map((a) => `  • \`${a.email}\``),
        );
      }
      if (dkimBroken.length) {
        authLines.push(
          `:rotating_light: *DKIM is FAILING on ${dkimBroken.length} sender${dkimBroken.length === 1 ? "" : "s"}*:`,
          ...dkimBroken.slice(0, 8).map((a) => `  • \`${a.email}\``),
        );
      }
    }

    const senderLines: string[] = [];
    const senders = details.senders ?? [];
    if (senders.length) {
      const weakSenders = senders
        .filter((s) => s.inboxPercent < (details.remediationThreshold ?? 80))
        .sort((a, b) => a.inboxPercent - b.inboxPercent);
      if (weakSenders.length) {
        senderLines.push(
          "",
          `*Weak senders (under ${details.remediationThreshold ?? 80}%):*`,
          ...weakSenders.slice(0, 15).map((s) => {
            const esp = s.scoredSameEsp ? "" : " _(blended ESP)_";
            const action = s.willRemediate
              ? ` → pulling off campaigns, ${details.holdDays ?? 14}d warmup, generic rotated in`
              : "";
            return `  • \`${s.email}\` — ${s.inboxPercent.toFixed(1)}%${esp}${action}`;
          }),
          ...(weakSenders.length > 15
            ? [`  • …and ${weakSenders.length - 15} more`]
            : []),
        );
      }
    }

    await this.send(
      [
        `*Placement look — ${details.testName || "campaign test"}*`,
        details.testId ? `Test id: \`${details.testId}\`` : undefined,
        overallLine,
        "",
        plainTake,
        "",
        ...scoreLines,
        ...authLines,
        ...senderLines,
        "",
        details.autoRemediation
          ? `Senders under ${details.remediationThreshold ?? 80}% same-ESP are pulled off campaigns automatically, warmed for ${details.holdDays ?? 14} days, and covered by an ESP-matched generic with the client's signature. No action needed unless I flag a burned domain.`
          : `Auto-remediation is OFF — these need manual handling.`,
      ]
        .filter((x): x is string => Boolean(x))
        .join("\n"),
    );
  }

  async notifyReconnect(summary: {
    dryRun?: boolean;
    scanned: number;
    disconnected: number;
    reconnected: number;
    skippedAlreadyConnected: number;
    failed: number;
    inboxkitReexports: number;
    errors: string[];
    actions?: Array<{ email: string; message: string; reauthenticated: boolean }>;
  }): Promise<void> {
    if (
      summary.disconnected === 0 &&
      summary.inboxkitReexports === 0 &&
      summary.errors.length === 0
    ) {
      return;
    }

    const reconnected = (summary.actions ?? [])
      .filter((a) => a.reauthenticated)
      .slice(0, 12)
      .map((a) => `• \`${a.email}\``);
    const failed = (summary.actions ?? [])
      .filter((a) => !a.reauthenticated && !/already/i.test(a.message || ""))
      .slice(0, 8)
      .map((a) => `• \`${a.email}\` — ${a.message || "failed"}`);

    await this.send(
      [
        `*Disconnected Smartlead accounts*`,
        `Checked ${summary.scanned} accounts. ${summary.disconnected} were disconnected.`,
        summary.reconnected > 0
          ? `Reconnected ${summary.reconnected}:`
          : undefined,
        ...reconnected,
        summary.failed > 0
          ? `Couldn't reconnect ${summary.failed} (may need manual OAuth in Smartlead):`
          : undefined,
        ...failed,
        summary.inboxkitReexports > 0
          ? `Also re-queued ${summary.inboxkitReexports} failed InboxKit→Smartlead exports.`
          : undefined,
        (() => {
          const serious = summary.errors
            .filter((e) => !isRateLimitNoise(e))
            .map(humanizeAlertError);
          return serious.length
            ? `What went wrong:\n${serious
                .slice(0, 8)
                .map((e) => `• ${e}`)
                .join("\n")}`
            : undefined;
        })(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async notifyWarmupGate(summary: {
    dryRun?: boolean;
    campaignsScanned: number;
    accountsChecked: number;
    removed: number;
    skipped: number;
    pausedCampaigns: number[];
    removals: Array<{
      campaignId: number;
      campaignName: string;
      email: string;
      reason: string;
      daysWarmed: number | null;
      holdUntil?: string;
    }>;
    errors: string[];
  }): Promise<void> {
    const seriousErrors = summary.errors
      .filter((e) => !isRateLimitNoise(e))
      .map(humanizeAlertError);

    // Rate-limit-only failures with no removals are noise — log locally, don't page.
    if (summary.removed === 0 && seriousErrors.length === 0) return;

    const under = summary.removals.filter((r) => r.reason === "under_warmed");
    const held = summary.removals.filter((r) => r.reason === "hold_until");

    const byCampaign = new Map<string, typeof summary.removals>();
    for (const row of summary.removals) {
      const key = row.campaignName;
      const list = byCampaign.get(key) ?? [];
      list.push(row);
      byCampaign.set(key, list);
    }

    const campaignBlocks: string[] = [];
    for (const [label, rows] of byCampaign) {
      const lines = rows.slice(0, 10).map((r) => {
        if (r.reason === "hold_until") {
          return `• \`${r.email}\` — still on recovery hold until ${r.holdUntil}`;
        }
        const days =
          r.daysWarmed == null ? "?" : `${r.daysWarmed.toFixed(0)}`;
        return `• \`${r.email}\` — only warmed ${days} days (need 14)`;
      });
      const more =
        rows.length > 10 ? `\n• …and ${rows.length - 10} more` : "";
      campaignBlocks.push(
        `*${label}* — took off ${rows.length}\n${lines.join("\n")}${more}`,
      );
    }

    // Don't claim we pulled mailboxes when the check itself failed.
    if (summary.removed === 0) {
      await this.send(
        [
          `*Couldn't finish checking campaign warmup*`,
          `We hit a problem loading mailbox data from Smartlead, so we didn't take anyone off campaigns.`,
          "",
          `What went wrong:`,
          ...seriousErrors.slice(0, 8).map((e) => `• ${e}`),
        ].join("\n"),
      );
      return;
    }

    await this.send(
      [
        `*Pulled not-ready mailboxes off live campaigns*`,
        under.length
          ? `${under.length} hadn't finished the 14-day warmup.`
          : undefined,
        held.length
          ? `${held.length} still had a HOLD recovery tag.`
          : undefined,
        summary.pausedCampaigns.length
          ? `Paused campaign(s) that would have been empty: ${summary.pausedCampaigns.join(", ")}`
          : undefined,
        "",
        ...campaignBlocks,
        seriousErrors.length
          ? `\nWhat went wrong:\n${seriousErrors
              .slice(0, 8)
              .map((e) => `• ${e}`)
              .join("\n")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async notifyTestReconcile(summary: {
    dryRun: boolean;
    automatedTests: number;
    stopped: Array<{
      testId: string;
      testName?: string;
      campaignId: string;
      campaignStatus: string;
    }>;
    orphaned: string[];
    errors: string[];
  }): Promise<void> {
    if (!summary.stopped.length && !summary.errors.length) return;

    await this.send(
      [
        `*Stopped recurring placement tests*`,
        summary.stopped.length
          ? `${summary.stopped.length} test${summary.stopped.length === 1 ? "" : "s"} stopped because the campaign is no longer active — this stops them from burning test runs.`
          : undefined,
        ...summary.stopped
          .slice(0, 12)
          .map(
            (s) =>
              `• ${s.testName ? `*${s.testName}*` : `test \`${s.testId}\``} — campaign ${s.campaignId} is ${s.campaignStatus}`,
          ),
        summary.orphaned.length
          ? `\n${summary.orphaned.length} recurring test(s) have no matching campaign in Smartlead — left running, check manually: ${summary.orphaned.slice(0, 5).join(", ")}`
          : undefined,
        (() => {
          const serious = summary.errors
            .filter((e) => !isRateLimitNoise(e))
            .map(humanizeAlertError);
          return serious.length
            ? `\nWhat went wrong:\n${serious
                .slice(0, 8)
                .map((e) => `• ${e}`)
                .join("\n")}`
            : undefined;
        })(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async notifyRemediation(details: {
    dryRun: boolean;
    blacklistedDomains: string[];
    deletedSmartleadAccounts: Array<{
      id: number;
      email: string;
      domain: string;
      clientId?: number | null;
      clientName?: string;
    }>;
    purgedInboxKitDomains: string[];
    recoveredInboxes: Array<{
      id: number;
      email: string;
      inboxRate: number;
      inboxRateAll?: number;
      scoredSameEsp?: boolean;
      removedFromCampaigns: number[];
      holdUntil?: string;
      tagName?: string;
      warmupEnabled?: boolean;
      clientId?: number | null;
      clientName?: string;
    }>;
    sameEspAudit?: {
      falseHoldsFound: number;
      restored: Array<{
        email: string;
        inboxRate: number;
        inboxRateAll?: number;
        reattachedCampaignIds: number[];
        clientName?: string;
        reason: string;
      }>;
      stillHeldBelowThreshold: number;
    };
    clientActions?: Array<{
      clientId: number | null;
      clientName: string;
      domainsToReplace: string[];
      inboxesToReplace: number;
      sampleEmails: string[];
      holdUntil?: string;
      affectedCampaignIds: number[];
      pausedCampaignIds: number[];
    }>;
    holdTagged?: number;
    pausedCampaigns: number[];
    errors: string[];
  }): Promise<void> {
    const actions = details.clientActions ?? [];
    const restored = details.sameEspAudit?.restored ?? [];
    const seriousErrors = details.errors
      .filter((e) => !isBenignOpsNoise(e))
      .map(humanizeAlertError);

    const didSomething =
      details.deletedSmartleadAccounts.length > 0 ||
      details.purgedInboxKitDomains.length > 0 ||
      details.recoveredInboxes.length > 0 ||
      restored.length > 0 ||
      actions.length > 0 ||
      (typeof details.holdTagged === "number" && details.holdTagged > 0) ||
      details.pausedCampaigns.length > 0;

    // Don't ping for empty "all clear" or rate-limit / approval-gate noise
    if (!didSomething && !seriousErrors.length) return;

    const parts: string[] = [];

    if (actions.length > 0) {
      parts.push(
        `*You need to order replacements* for ${actions.length} client${actions.length === 1 ? "" : "s"}:`,
      );
      for (const a of actions) {
        const need: string[] = [];
        if (a.domainsToReplace.length) {
          need.push(
            `${a.domainsToReplace.length} domain${a.domainsToReplace.length === 1 ? "" : "s"} (${a.domainsToReplace.map((d) => `\`${d}\``).join(", ")})`,
          );
        }
        if (a.inboxesToReplace) {
          need.push(
            `${a.inboxesToReplace} mailbox${a.inboxesToReplace === 1 ? "" : "es"}`,
          );
        }
        parts.push(`• *${a.clientName}* — ${need.join(" + ")}`);
        if (a.sampleEmails.length) {
          parts.push(
            `  examples: ${a.sampleEmails
              .slice(0, 5)
              .map((e) => `\`${e}\``)
              .join(", ")}`,
          );
        }
        parts.push(
          `  Connect new mailboxes in Smartlead for *${a.clientName}* and add them to the live campaigns. Don't reuse deleted domains.`,
        );
      }
      parts.push("");
    } else {
      parts.push(`*Remediation update*`);
    }

    if (details.deletedSmartleadAccounts.length) {
      parts.push(
        `Deleted ${details.deletedSmartleadAccounts.length} blacklisted Smartlead account${details.deletedSmartleadAccounts.length === 1 ? "" : "s"}:`,
      );
      for (const a of details.deletedSmartleadAccounts.slice(0, 12)) {
        parts.push(
          `• \`${a.email}\`${a.clientName ? ` (${a.clientName})` : ""}`,
        );
      }
    }

    if (details.purgedInboxKitDomains.length) {
      parts.push(
        `Purged from InboxKit: ${details.purgedInboxKitDomains
          .map((d) => `\`${d}\``)
          .join(", ")}`,
      );
    }

    if (details.recoveredInboxes.length) {
      parts.push(
        `Pulled ${details.recoveredInboxes.length} weak inbox${details.recoveredInboxes.length === 1 ? "" : "es"} off campaigns for warmup:`,
      );
      for (const a of details.recoveredInboxes.slice(0, 12)) {
        const hold = a.holdUntil ? ` · hold until ${a.holdUntil}` : "";
        parts.push(
          `• \`${a.email}\` — ${a.inboxRate.toFixed(0)}%${hold}`,
        );
      }
    }

    if (restored.length) {
      parts.push(
        `Put ${restored.length} inbox${restored.length === 1 ? "" : "es"} back on campaigns (same-ESP looks healthy again):`,
      );
      for (const a of restored.slice(0, 12)) {
        parts.push(
          `• \`${a.email}\` — ${a.inboxRate.toFixed(0)}%`,
        );
      }
    }

    if (details.pausedCampaigns.length) {
      parts.push(
        `Paused empty campaign(s): ${details.pausedCampaigns.join(", ")}`,
      );
    }

    if (seriousErrors.length) {
      parts.push(
        "",
        `What went wrong:`,
        ...seriousErrors.slice(0, 10).map((e) => `• ${e}`),
      );
    }

    await this.send(parts.filter(Boolean).join("\n"));
  }
}
