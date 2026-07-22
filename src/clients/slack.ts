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
          `• *${c.name}* (\`${c.id}\`) — would use ${c.testsNeeded} test${c.testsNeeded === 1 ? "" : "s"}`,
      )
      .join("\n");

    await this.send(
      [
        `:no_entry: *SmartDelivery quota would be exceeded — batch skipped*`,
        `Channel: ${this.creds.channelLabel}`,
        `Used: *${details.used}* / *${details.quota}*`,
        `This batch needs *${details.needed}* more test(s).`,
        `No placement tests were created. Decide whether to skip a campaign, prioritize, or wait for quota reset.`,
        lines || "_No campaign details_",
      ].join("\n"),
    );
  }

  async notifyRunSummary(summary: {
    scanned: number;
    eligible: number;
    created: number;
    skipped: number;
    errors: string[];
  }): Promise<void> {
    const errorBlock =
      summary.errors.length > 0
        ? `\n:warning: Errors:\n${summary.errors.map((e) => `• ${e}`).join("\n")}`
        : "";

    await this.send(
      [
        `:white_check_mark: *Deliverability scan complete*`,
        `Campaigns scanned: *${summary.scanned}*`,
        `New / untested eligible: *${summary.eligible}*`,
        `Placement tests created: *${summary.created}*`,
        `Skipped: *${summary.skipped}*`,
        errorBlock,
      ]
        .filter(Boolean)
        .join("\n"),
    );
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
   * Example Slack body leads with an explicit domain list.
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
      const ipBits = related
        .filter((h) => h.ip)
        .map((h) => {
          const list = h.listName ? ` on ${h.listName}` : "";
          return `\`${h.ip}\`${list}`;
        });
      const extras = [
        fromEmail ? `sender \`${fromEmail}\`` : undefined,
        ipBits.length ? `IP ${ipBits.join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      return extras
        ? `• *${domain}* — ${extras}`
        : `• *${domain}*`;
    });

    await this.send(
      [
        `:rotating_light: *Blacklisted domain${domains.length === 1 ? "" : "s"} detected*`,
        details.testName
          ? `Test: *${details.testName}* (\`${details.testId}\`)`
          : `Test: \`${details.testId}\``,
        "",
        `*Blacklisted domain${domains.length === 1 ? "" : "s"}:*`,
        ...domainLines,
        "",
        `*ACTION REQUIRED*`,
        `You need to backfill *${domains.length}* domain${domains.length === 1 ? "" : "s"} (and their mailboxes) for the affected client.`,
        `1. Confirm remediation deleted these from Smartlead + InboxKit`,
        `2. Buy/provision replacement domain(s) + mailboxes for that client`,
        `3. Connect new mailboxes in Smartlead and attach to the client's campaigns`,
        `4. Do *not* reuse the blacklisted domain(s)`,
      ].join("\n"),
    );
  }

  async notifyLowDeliverability(details: {
    label: string;
    score: number;
    threshold: number;
    context?: string;
  }): Promise<void> {
    await this.send(
      [
        `:warning: *Deliverability below ${details.threshold}%*`,
        `Inbox / mailbox: *${details.label}*`,
        `Placement: *${details.score.toFixed(1)}%*`,
        details.context,
        "",
        `*ACTION REQUIRED*`,
        `If remediation is enabled, low inboxes (<80%) are pulled for warmup automatically.`,
        `1. Check the remediation Slack message for *how many inboxes per client* to backfill`,
        `2. Order replacement mailboxes for that client`,
        `3. Connect them in Smartlead and add to active campaigns`,
        `4. Leave any \`HOLD-UNTIL-*\` tagged inboxes on warmup until the date on the tag`,
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
    const mode = details.dryRun ? "DRY RUN (no changes applied)" : "LIVE";
    const actions = details.clientActions ?? [];

    const headlineParts = actions.map((a) => {
      const bits: string[] = [];
      if (a.domainsToReplace.length) {
        bits.push(
          `*${a.domainsToReplace.length}* domain${a.domainsToReplace.length === 1 ? "" : "s"}`,
        );
      }
      if (a.inboxesToReplace) {
        bits.push(
          `*${a.inboxesToReplace}* inbox${a.inboxesToReplace === 1 ? "" : "es"}`,
        );
      }
      return `• *${a.clientName}* — backfill ${bits.join(" + ")}`;
    });

    const perClientBlocks = actions.map((a) => {
      const domainLine = a.domainsToReplace.length
        ? `• Replace *${a.domainsToReplace.length}* domain${a.domainsToReplace.length === 1 ? "" : "s"}: ${a.domainsToReplace
            .map((d) => `\`${d}\``)
            .join(", ")}`
        : undefined;
      const inboxLine = a.inboxesToReplace
        ? `• Replace *${a.inboxesToReplace}* inbox${a.inboxesToReplace === 1 ? "" : "es"} pulled for warmup${
            a.holdUntil ? ` (hold until *${a.holdUntil}*)` : ""
          }`
        : undefined;
      const sample =
        a.sampleEmails.length > 0
          ? `  samples: ${a.sampleEmails.map((e) => `\`${e}\``).join(", ")}${
              a.inboxesToReplace > a.sampleEmails.length ? ", …" : ""
            }`
          : undefined;
      const campaigns =
        a.affectedCampaignIds.length > 0
          ? `• Affected campaigns: ${a.affectedCampaignIds.map((id) => `\`${id}\``).join(", ")}`
          : undefined;
      const paused =
        a.pausedCampaignIds.length > 0
          ? `• Paused (would have been empty): ${a.pausedCampaignIds
              .map((id) => `\`${id}\``)
              .join(", ")}`
          : undefined;

      const orderLine = (() => {
        const d = a.domainsToReplace.length;
        const i = a.inboxesToReplace;
        if (d && i) {
          return `1. In InboxKit, order *${d}* domain${d === 1 ? "" : "s"} + *${i}* mailbox${i === 1 ? "" : "es"} for *${a.clientName}*`;
        }
        if (d) {
          return `1. In InboxKit, order *${d}* replacement domain${d === 1 ? "" : "s"} (+ mailboxes) for *${a.clientName}*`;
        }
        return `1. In InboxKit, order *${i}* replacement mailbox${i === 1 ? "" : "es"} for *${a.clientName}*`;
      })();

      const steps = [
        orderLine,
        `2. Connect the new mailboxes in Smartlead under client *${a.clientName}*`,
        a.affectedCampaignIds.length
          ? `3. Attach them to campaigns: ${a.affectedCampaignIds.map((id) => `\`${id}\``).join(", ")}`
          : `3. Attach them to that client's active campaigns`,
        a.pausedCampaignIds.length
          ? `4. Restart paused campaigns once stocked: ${a.pausedCampaignIds.map((id) => `\`${id}\``).join(", ")}`
          : undefined,
        a.holdUntil
          ? `${a.pausedCampaignIds.length ? "5" : "4"}. Do *NOT* put \`HOLD-UNTIL-*\` inboxes back on campaigns until *${a.holdUntil}*`
          : `${a.pausedCampaignIds.length ? "5" : "4"}. Leave pulled inboxes on warmup until their HOLD-UNTIL tag date`,
      ].filter(Boolean);

      return [
        `*${a.clientName}*${a.clientId != null ? ` (\`${a.clientId}\`)` : ""}`,
        domainLine,
        inboxLine,
        sample,
        campaigns,
        paused,
        `*Do this next:*`,
        ...steps,
      ]
        .filter(Boolean)
        .join("\n");
    });

    const deletedLines = details.deletedSmartleadAccounts
      .slice(0, 15)
      .map((a) => {
        const client = a.clientName ? ` · *${a.clientName}*` : "";
        return `• \`${a.email}\` (\`${a.domain}\`)${client}`;
      })
      .join("\n");

    const recoveredLines = details.recoveredInboxes
      .slice(0, 15)
      .map((a) => {
        const client = a.clientName ? ` · *${a.clientName}*` : "";
        const hold = a.holdUntil ? ` · hold *${a.holdUntil}*` : "";
        const same = a.scoredSameEsp ? " same-ESP" : "";
        const blended =
          typeof a.inboxRateAll === "number" && a.scoredSameEsp
            ? ` (all-ESP ${a.inboxRateAll.toFixed(1)}%)`
            : "";
        return `• \`${a.email}\` — ${a.inboxRate.toFixed(1)}%${same}${blended}${client}${hold}`;
      })
      .join("\n");

    const restored = details.sameEspAudit?.restored ?? [];
    const restoredLines = restored
      .slice(0, 20)
      .map((a) => {
        const client = a.clientName ? ` · *${a.clientName}*` : "";
        const camps = a.reattachedCampaignIds.length
          ? ` → campaigns ${a.reattachedCampaignIds.map((id) => `\`${id}\``).join(", ")}`
          : " → no active/paused campaign to reattach (HOLD cleared)";
        const blended =
          typeof a.inboxRateAll === "number"
            ? ` · was blended ${a.inboxRateAll.toFixed(1)}%`
            : "";
        return `• \`${a.email}\` — same-ESP *${a.inboxRate.toFixed(1)}%*${blended}${client}${camps}`;
      })
      .join("\n");

    const errorBlock =
      details.errors.length > 0
        ? `\n:warning: Errors:\n${details.errors
            .slice(0, 15)
            .map((e) => `• ${e}`)
            .join("\n")}`
        : "";

    const actionHeader =
      actions.length > 0
        ? [
            `:rotating_light: *ACTION REQUIRED — backfill by client* (${mode})`,
            `You need to backfill inventory for *${actions.length}* client${actions.length === 1 ? "" : "s"}:`,
            ...headlineParts,
            "",
            ...perClientBlocks,
          ].join("\n\n")
        : `:hammer_and_wrench: *Deliverability remediation (${mode})* — no new domain/inbox replacements needed this run`;

    await this.send(
      [
        actionHeader,
        "",
        `*Scoring:* same-ESP only (Gmail→G Suite / Outlook→Office365), matching campaign ESP matching`,
        "",
        `*Summary*`,
        details.blacklistedDomains.length
          ? `Blacklisted domains still needing action: ${details.blacklistedDomains
              .map((d) => `\`${d}\``)
              .join(", ")}`
          : undefined,
        details.purgedInboxKitDomains.length
          ? `InboxKit purged: ${details.purgedInboxKitDomains
              .map((d) => `\`${d}\``)
              .join(", ")}`
          : undefined,
        `Smartlead accounts deleted: *${details.deletedSmartleadAccounts.length}*`,
        deletedLines || undefined,
        restored.length
          ? `*Same-ESP audit restore:* put back *${restored.length}* inbox${restored.length === 1 ? "" : "es"} that were pulled on blended scores but are ≥threshold same-ESP`
          : undefined,
        restoredLines || undefined,
        details.sameEspAudit
          ? `Still held (same-ESP below threshold): *${details.sameEspAudit.stillHeldBelowThreshold}*`
          : undefined,
        `Inboxes pulled for warmup (same-ESP): *${details.recoveredInboxes.length}*`,
        recoveredLines || undefined,
        typeof details.holdTagged === "number" && details.holdTagged > 0
          ? `HOLD-UNTIL tags applied/confirmed: *${details.holdTagged}*`
          : undefined,
        details.pausedCampaigns.length
          ? `Campaigns paused: ${details.pausedCampaigns.join(", ")}`
          : undefined,
        errorBlock,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}
