export class SlackClient {
  constructor(
    private readonly webhookUrl: string,
    private readonly channelLabel: string,
  ) {}

  async send(text: string, blocks?: unknown[]): Promise<void> {
    if (!this.webhookUrl || this.webhookUrl.includes("placeholder")) {
      throw new Error("SLACK_WEBHOOK_URL is not configured");
    }

    const payload: Record<string, unknown> = {
      text,
      username: "Deliverability Wizard",
      icon_emoji: ":mailbox_with_mail:",
    };
    if (blocks?.length) payload.blocks = blocks;

    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Slack webhook failed (${response.status}): ${body}`);
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
        `Channel: ${this.channelLabel}`,
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
    await this.send(
      [
        `:rotating_light: *Domain / IP blacklist detected*`,
        details.testName ? `Test: *${details.testName}* (\`${details.testId}\`)` : `Test: \`${details.testId}\``,
        `Domain: *${details.domain}*`,
        details.ip ? `IP: \`${details.ip}\`` : undefined,
        details.fromEmail ? `Sender: \`${details.fromEmail}\`` : undefined,
        details.total !== undefined ? `Blacklist hits: *${details.total}*` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
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
