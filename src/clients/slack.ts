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
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}
