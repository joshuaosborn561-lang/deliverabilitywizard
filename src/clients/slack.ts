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
    if (summary.errors.length) {
      lines.push(
        "",
        `Problems:`,
        ...summary.errors.slice(0, 8).map((e) => `• ${e}`),
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

    await this.send(
      [
        `*Placement look — ${details.testName || "campaign test"}*`,
        details.testId ? `Test id: \`${details.testId}\`` : undefined,
        "",
        plainTake,
        "",
        ...scoreLines,
        "",
        details.autoRemediation
          ? `If individual senders are under 80% same-ESP, remediation pulls them for warmup automatically. No need to buy replacements unless I ping you that domains were deleted.`
          : undefined,
      ]
        .filter(Boolean)
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
    if (summary.removed === 0 && summary.errors.length === 0) return;

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
        summary.errors.length
          ? `\nProblems:\n${summary.errors
              .slice(0, 8)
              .map((e) => `• ${e}`)
              .join("\n")}`
          : undefined,
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
    const seriousErrors = details.errors.filter(
      (e) => !/rate limit/i.test(e),
    );

    const didSomething =
      details.deletedSmartleadAccounts.length > 0 ||
      details.purgedInboxKitDomains.length > 0 ||
      details.recoveredInboxes.length > 0 ||
      restored.length > 0 ||
      actions.length > 0 ||
      (typeof details.holdTagged === "number" && details.holdTagged > 0) ||
      details.pausedCampaigns.length > 0;

    // Don't ping for empty "all clear" or rate-limit noise
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
        `Problems:`,
        ...seriousErrors.slice(0, 10).map((e) => `• ${e}`),
      );
    }

    await this.send(parts.filter(Boolean).join("\n"));
  }
}
