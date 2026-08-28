import { readFileSync } from "node:fs";
import {
  humanizeAlertError,
  isBenignOpsNoise,
  isRateLimitNoise,
} from "../lib/alertNoise.js";
import { slackActionHref } from "../lib/slackActionLink.js";
import {
  slackAllowed,
  slackKindForIsolationAction,
  type SlackAllowKind,
} from "../lib/slackAllow.js";
import { isolationActionValue } from "../lib/slackSignature.js";
import {
  SWAP_EDIT_ACTION_ID,
  swapEditModalView,
} from "../lib/slackSwapEdit.js";

export interface SlackCredentials {
  webhookUrl?: string;
  botToken?: string;
  /** If this file exists, it wins over botToken (new Slack app install). */
  botTokenFile?: string;
  channelId?: string;
  channelLabel: string;
  /** Used to sign /slack/action links so buttons work even when posted by another bot. */
  actionLinkSecret?: string;
  publicBaseUrl?: string;
}

export function readSlackBotToken(creds: SlackCredentials): string {
  const file = creds.botTokenFile?.trim();
  if (file) {
    try {
      const fromFile = readFileSync(file, "utf8").trim();
      if (fromFile) return fromFile;
    } catch {
      // File missing until Josh installs the new Slack app.
    }
  }
  return creds.botToken?.trim() ?? "";
}

export class SlackClient {
  constructor(private readonly creds: SlackCredentials) {}

  /**
   * D71 — only burned-domain replace, isolated-word replace, the EOD
   * send/spam scoreboard, and the reply after Josh taps a button.
   * Unclassified calls log and do not post.
   */
  async send(
    text: string,
    blocks?: unknown[],
    kind?: SlackAllowKind,
  ): Promise<void> {
    if (!slackAllowed(kind)) {
      console.log(
        `[slack-quiet] dropped ${kind ?? "unclassified"}: ${text.replace(/\n/g, " ").slice(0, 200)}`,
      );
      return;
    }
    if (readSlackBotToken(this.creds)) {
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

  async notifyActionResult(text: string): Promise<void> {
    await this.send(text, undefined, "action_result");
  }

  /**
   * D153 — open the "Write my own edit" modal. Needs a trigger_id from a
   * block_actions payload within ~3s (Slack rule).
   */
  async viewsOpen(
    triggerId: string,
    view: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    const token = readSlackBotToken(this.creds);
    if (!token) {
      return { ok: false, error: "Slack bot token missing — cannot open modal" };
    }
    const response = await fetch("https://slack.com/api/views.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ trigger_id: triggerId, view }),
    });
    const body = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || !body.ok) {
      return { ok: false, error: body.error || `HTTP ${response.status}` };
    }
    return { ok: true };
  }

  /** D153 — modal that shows the exact find phrase, then Josh's replacement. */
  async openSwapEditModal(opts: {
    triggerId: string;
    actionId: string;
    element: string;
    suggestedSwap: string;
    campaignName?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    return this.viewsOpen(
      opts.triggerId,
      swapEditModalView({
        actionId: opts.actionId,
        element: opts.element,
        suggestedSwap: opts.suggestedSwap,
        campaignName: opts.campaignName,
      }),
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
        Authorization: `Bearer ${readSlackBotToken(this.creds)}`,
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
        `*Couldn't create placement tests — a cap we set is full*`,
        `Used ${details.used} of ${details.quota}. This batch needed ${details.needed} more.`,
        `Nothing new was created. Raise the cap or skip a campaign, then try again.`,
        lines || undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  /**
   * Top-line fleet volume by client. Sent / bounce% / spam% for the day, plus
   * active vs resting client-inbox counts (D39/D43). Replaces per-mailbox lists.
   */
  async notifyClientDayBrief(summary: {
    date: string;
    totalSent: number;
    rows: Array<{
      clientName: string;
      sent: number;
      bouncePercent: number | null;
      spamPercent: number | null;
      activeInboxes: number;
      restingInboxes?: number;
      genericSpare?: number;
    }>;
    errors: string[];
    /** D64 — staffing picture only on the end-of-day brief. */
    endOfDay?: boolean;
    staffingShorts?: Array<{
      name: string;
      staffable: number;
      shortBy: number;
      status: string;
    }>;
    /** D85 — campaigns the tagger cannot match to a client (D77 forbids guessing). */
    untaggedCampaigns?: Array<{ id: number; name: string }>;
    /** D89 — DRAFT campaigns that already have leads and are not sending. */
    loadedDrafts?: Array<{ id: number; name: string; remaining: number }>;
    /** D136 — sending domains whose client story needs a human. */
    domainAdvisories?: Array<{ domain: string; kind: string; note: string }>;
    /** D143 — memberships an outside writer keeps re-adding after gate pulls. */
    warmupBoomerangs?: Array<{
      email: string;
      campaignId: number;
      campaignName: string;
      count: number;
    }>;
    /** D85 — set when the unwarmed canary fleet has zero connected mailboxes. */
    canaryFleetDownSince?: string | null;
  }): Promise<void> {
    const lines = [
      `*Client day — ${summary.date}*`,
      `${summary.totalSent.toLocaleString("en-US")} email${summary.totalSent === 1 ? "" : "s"} sent across ${summary.rows.length} client${summary.rows.length === 1 ? "" : "s"}.`,
      "",
    ];

    if (!summary.endOfDay) {
      console.log(
        `[slack-quiet] midday client-day ${summary.date} ${summary.totalSent} sent`,
      );
      return;
    }

    for (const row of summary.rows.slice(0, 25)) {
      const spam =
        row.spamPercent == null ? "—" : `${row.spamPercent.toFixed(1)}%`;
      lines.push(
        `• *${row.clientName}* — ${row.sent.toLocaleString("en-US")} sent · ${spam} spam`,
      );
    }
    if (summary.rows.length > 25) {
      lines.push(`• …and ${summary.rows.length - 25} more clients`);
    }

    // D64 — the staffing picture belongs on the EOD brief. (The field was
    // plumbed through but never rendered until D85 — a silently dropped line.)
    const shorts = (summary.staffingShorts ?? []).filter((s) => s.shortBy > 0);
    if (shorts.length) {
      lines.push(
        "",
        `Still short of senders at end of day (${shorts.length}):`,
        ...shorts
          .slice(0, 10)
          .map(
            (s) =>
              `• ${s.name} — ${s.staffable} sending, ${s.shortBy} more needed (${s.status})`,
          ),
      );
      if (shorts.length > 10) lines.push(`• …and ${shorts.length - 10} more`);
    }

    // D85 — campaigns with no client tag sit blocked at QA and I cannot
    // guess the client (D77). Naming them daily is the escalation.
    const untagged = summary.untaggedCampaigns ?? [];
    if (untagged.length) {
      lines.push(
        "",
        `No client tag (${untagged.length}) — QA stays blocked until someone tags them in Smartlead (campaign → client):`,
        ...untagged.slice(0, 10).map((c) => `• ${c.name} (#${c.id})`),
      );
      if (untagged.length > 10) lines.push(`• …and ${untagged.length - 10} more`);
    }

    // D136 — a domain split across clients or mapped to none is a human
    // question; the audit never guesses.
    const domainAdvisories = summary.domainAdvisories ?? [];
    if (domainAdvisories.length) {
      lines.push(
        "",
        `Domains needing a human (${domainAdvisories.length}) — I will not guess the client:`,
        ...domainAdvisories
          .slice(0, 10)
          .map((row) => `• ${row.domain} — ${row.note}`),
      );
      if (domainAdvisories.length > 10) {
        lines.push(`• …and ${domainAdvisories.length - 10} more`);
      }
    }

    // D143 — the warmup gate keeps pulling these and something outside this
    // app keeps putting them back. Grouped per mailbox so 7 boxes on 12
    // campaigns read as 7 lines, not 84.
    const boomerangs = summary.warmupBoomerangs ?? [];
    if (boomerangs.length) {
      const byEmail = new Map<string, { pulls: number; campaigns: number }>();
      for (const row of boomerangs) {
        const entry = byEmail.get(row.email) ?? { pulls: 0, campaigns: 0 };
        entry.pulls = Math.max(entry.pulls, row.count);
        entry.campaigns += 1;
        byEmail.set(row.email, entry);
      }
      lines.push(
        "",
        `Something outside this app keeps re-adding under-warmed inboxes (${byEmail.size} mailbox${byEmail.size === 1 ? "" : "es"}). I pull them off every pass and they come back within minutes — check InboxKit campaign assignment (or any other automation) and switch it off:`,
        ...[...byEmail.entries()]
          .slice(0, 8)
          .map(
            ([email, entry]) =>
              `• \`${email}\` — re-added ${entry.pulls}× in 24h across ${entry.campaigns} campaign${entry.campaigns === 1 ? "" : "s"}`,
          ),
      );
      if (byEmail.size > 8) lines.push(`• …and ${byEmail.size - 8} more`);
    }

    // D89 — leads sitting in draft, nothing going out.
    const drafts = summary.loadedDrafts ?? [];
    if (drafts.length) {
      lines.push(
        "",
        `Leads loaded, not sending (${drafts.length}):`,
        ...drafts
          .slice(0, 10)
          .map(
            (c) =>
              `• ${c.name} (#${c.id}) — about ${c.remaining.toLocaleString("en-US")} lead${c.remaining === 1 ? "" : "s"} sitting in draft`,
          ),
      );
      if (drafts.length > 10) lines.push(`• …and ${drafts.length - 10} more`);
    }

    // D85 — one line for the fleet, not 48 findings.
    if (summary.canaryFleetDownSince) {
      lines.push(
        "",
        `Unwarmed canary fleet has zero connected mailboxes (since ${summary.canaryFleetDownSince.slice(0, 10)}). Placement measurement is blind — reconnect the fleet in Smartlead or approve a fleet buy.`,
      );
    }

    const seriousErrors = summary.errors
      .filter((e) => !isRateLimitNoise(e))
      .map(humanizeAlertError);
    if (seriousErrors.length) {
      lines.push(
        "",
        "Could not read some clients:",
        ...seriousErrors.slice(0, 5).map((e) => `• ${e}`),
      );
    }

    await this.send(lines.join("\n"), undefined, "eod_summary");
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
      .filter((e) => !isBenignOpsNoise(e))
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
    });
  }

  async notifyPlacementResult(details: {
    testName?: string;
    testId?: string;
    threshold: number;
    providers: Array<{ name: string; inboxPercent: number }>;
    /** Overall inbox/tab/spam split for the whole test. */
    overall?: { inboxPercent: number; tabPercent: number; spamPercent: number };
    /** Per-sender placement, worst first. */
    senders?: Array<{
      email: string;
      inboxPercent: number;
      scoredSameEsp?: boolean;
    }>;
    /** Senders whose SPF or DKIM is failing on every seed. */
    authFailures?: Array<{
      email: string;
      spfFailing: boolean;
      dkimFailing: boolean;
    }>;
    remediationThreshold?: number;
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

    // Per-mailbox weak lists are replaced by the client day brief (D39).
    // Keep SPF/DKIM failures — those need a named mailbox to fix DNS.
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

    const weakSenderCount = (details.senders ?? []).filter(
      (s) => s.inboxPercent < (details.remediationThreshold ?? 80),
    ).length;

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
        weakSenderCount
          ? `\n_${weakSenderCount} inbox${weakSenderCount === 1 ? "" : "es"} on this test landed below ${details.remediationThreshold ?? 80}% in their own mailbox type (Gmail or Outlook). Check the daily client note for bounce/spam._`
          : undefined,
        "",
        `I don't pull inboxes automatically — if a domain turns out burned, the spam investigation flags it and asks before buying a replacement.`,
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
          ? `Also retried ${summary.inboxkitReexports} failed InboxKit export${summary.inboxkitReexports === 1 ? "" : "s"} into Smartlead.`
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
      undefined,
      "action_result",
    );
  }

  async notifyWarmupGate(summary: {
    dryRun?: boolean;
    campaignsScanned: number;
    accountsChecked: number;
    removed: number;
    skipped: number;
    /** D139 — the warmup days the gate actually enforces (config, 21). */
    owedDays?: number;
    pausedCampaigns: number[];
    removals: Array<{
      campaignId: number;
      campaignName: string;
      email: string;
      reason: string;
      daysWarmed: number | null;
    }>;
    errors: string[];
  }): Promise<void> {
    const owedDays = summary.owedDays ?? 21;
    const seriousErrors = summary.errors
      .filter((e) => !isRateLimitNoise(e))
      .map(humanizeAlertError);

    // Rate-limit-only failures with no removals are noise — log locally, don't page.
    if (summary.removed === 0 && seriousErrors.length === 0) return;

    const under = summary.removals.filter((r) => r.reason === "under_warmed");

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
        const days =
          r.daysWarmed == null ? "?" : `${r.daysWarmed.toFixed(0)}`;
        return `• \`${r.email}\` — only warmed ${days} days (need ${owedDays})`;
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
          ? `${under.length} hadn't finished the ${owedDays}-day warmup.`
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
          ? `${summary.stopped.length} test${summary.stopped.length === 1 ? "" : "s"} stopped because the campaign is no longer active — no point testing a campaign that isn't sending.`
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

  async notifyIsolationVerdict(details: {
    campaignName: string;
    clientName?: string;
    podName?: string;
    dateLabel?: string;
    verdict: "INFRA" | "COPY" | "INCONCLUSIVE" | "HEALTHY";
    reason: string;
    repliesFrom?: number;
    repliesTo?: number;
    oooFrom?: number;
    oooTo?: number;
    bounceFlat?: boolean;
    teardownStarted?: boolean;
    infraSummary?: string;
    proof?: string;
  }): Promise<void> {
    const who = [details.clientName, details.campaignName, details.podName]
      .filter(Boolean)
      .join(" / ");
    const watch =
      details.repliesFrom != null && details.repliesTo != null
        ? `Replies ${details.repliesFrom} → ${details.repliesTo}` +
          (details.oooFrom != null && details.oooTo != null
            ? `, out-of-office ${details.oooFrom} → ${details.oooTo}`
            : "") +
          (details.bounceFlat ? ", bounces flat." : ".")
        : undefined;

    let verdictLine: string;
    if (details.verdict === "COPY") {
      verdictLine = details.teardownStarted
        ? "This campaign is in spam. That is a flag — something is wrong. The known-good email from the same inboxes landed, so this is the copy, not the inboxes. The word hunt is already running. I will not edit the live email until you tap Make the changes."
        : "This campaign is in spam. That is a flag — something is wrong. The known-good email from the same inboxes landed, so this is the copy, not the inboxes.";
    } else if (details.verdict === "INFRA") {
      verdictLine =
        "This campaign is in spam. That is a flag — something is wrong. The known-good email from the same inboxes also landed in spam, so this is the inboxes, not the copy. Do not rewrite the email.";
    } else if (details.verdict === "HEALTHY") {
      verdictLine = "Campaign and standing inbox test both look fine.";
    } else {
      verdictLine =
        details.reason ||
        "This campaign is in spam. That is a flag — either the inboxes or the copy. I need another known-good reading before I pick one.";
    }

    await this.send(
      [
        `*${who || details.campaignName}*${details.dateLabel ? ` / ${details.dateLabel}` : ""}`,
        watch,
        verdictLine,
        details.infraSummary,
        details.proof,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }

  async notifyCopyIsolation(details: {
    campaignName: string;
    recovered?: Array<{ element: string; kind: string }>;
    unchanged?: string[];
    noneRecovered?: boolean;
    waiting?: boolean;
    missingRig?: boolean;
  }): Promise<void> {
    // D71 — word-hunt progress/results are copy_word traffic (same lane as
    // the Make the changes ask). Unclassified send() was silently dropped,
    // so hunt completion never reached Slack.
    if (details.missingRig) {
      await this.send(
        [
          `*${details.campaignName}* — copy problem, word hunt waiting.`,
          "The standing inbox test says the inboxes are fine. We still need the low-rep test domain set (two mailboxes, never attached to a campaign) before we can isolate the word. We did not change the live email.",
        ].join("\n"),
        undefined,
        "copy_word",
      );
      return;
    }
    if (details.waiting) {
      await this.send(
        `*${details.campaignName}* — copy word hunt is in flight. Same-day tests from the low-rep domain; we will post what recovered. We are not editing the live email.`,
        undefined,
        "copy_word",
      );
      return;
    }
    if (details.noneRecovered) {
      await this.send(
        [
          `*${details.campaignName}* — no single change put this back in the inbox.`,
          "Likely the whole message shape, not one word. We did not change the live email.",
        ].join("\n"),
        undefined,
        "copy_word",
      );
      return;
    }
    const recovered = details.recovered ?? [];
    await this.send(
      [
        `*${details.campaignName}* — copy word hunt.`,
        recovered.length
          ? `Recovered when we changed: ${recovered
              .map((row) => `*${row.element}*`)
              .join(", ")}.`
          : undefined,
        details.unchanged?.length
          ? `No change: ${details.unchanged.slice(0, 8).join(", ")}.`
          : undefined,
        "Recommended: edit the live sequence to match the change that landed. We did not edit it.",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      undefined,
      "copy_word",
    );
  }

  async notifyPodControls(details: {
    pods: number;
    testsCreated: number;
    sendersRead: number;
    kill: number;
    watch: number;
    errors: string[];
  }): Promise<void> {
    if (
      !details.testsCreated &&
      !details.kill &&
      !details.watch &&
      !details.errors.length
    ) {
      return;
    }
    await this.send(
      [
        "*Standing inbox tests*",
        details.testsCreated
          ? `Started ${details.testsCreated} test${details.testsCreated === 1 ? "" : "s"} across ${details.pods} inbox group${details.pods === 1 ? "" : "s"}. Every inbox in the group is on the test.`
          : `Read ${details.sendersRead} inbox${details.sendersRead === 1 ? "" : "es"} on the standing tests.`,
        details.kill
          ? `${details.kill} inbox${details.kill === 1 ? "" : "es"} failed the standing test more than once — worth a cull look. We did not pull them.`
          : undefined,
        details.watch
          ? `${details.watch} more ${details.watch === 1 ? "inbox is" : "inboxes are"} on a watch after one fail.`
          : undefined,
        details.errors.length
          ? `What went wrong: ${details.errors.slice(0, 5).join("; ")}`
          : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
  }

  async notifyOooDetectionOff(campaigns: Array<{ id: number; name: string }>): Promise<void> {
    if (!campaigns.length) return;
    await this.send(
      [
        "Out-of-office detection is off on these campaigns, so the silent-delivery watch is blind:",
        ...campaigns.slice(0, 12).map((c) => `• ${c.name} (#${c.id})`),
        "Turn it on in Smartlead if you want that alert. We did not change campaign settings.",
      ].join("\n"),
    );
  }

  async notifyIsolationAction(details: {
    title: string;
    proof: string;
    actionId: string;
    kind:
      | "retire_domain"
      | "buy_domains"
      | "buy_isolation_domain"
      | "buy_canary_fleet"
      | "swap_copy"
      | "generic_backfill"
      | "add_signature_tag";
    who: string;
    /** D153 — exact find phrase for swap_copy (shown in message + modal). */
    element?: string;
    suggestedSwap?: string;
    campaignName?: string;
  }): Promise<void> {
    const approveLabel =
      details.kind === "swap_copy"
        ? "Use suggested edit"
        : details.kind === "add_signature_tag"
          ? "Add %signature%"
        : details.kind === "buy_domains"
          ? "Buy replacements"
          : details.kind === "buy_canary_fleet"
            ? "Buy canary fleet"
            : details.kind === "generic_backfill"
              ? "Allow generics"
              : "Retire this domain";
    const findPhrase = details.element?.trim() ?? "";
    const suggested = details.suggestedSwap ?? "";
    const text = [
      `*${details.title}*`,
      details.proof,
      details.kind === "swap_copy" && findPhrase
        ? [
            "",
            "*Replacing this exact phrase/word:*",
            `\`\`\`${findPhrase.slice(0, 2800)}\`\`\``,
            suggested.trim()
              ? `*Suggested edit:* ${suggested.trim()}`
              : "*Suggested edit:* delete that phrase",
          ].join("\n")
        : undefined,
      "",
      details.kind === "buy_domains"
        ? "Cayden cannot approve a purchase. Josh: tap the button (opens a confirm page) or open Railway → /ops."
        : details.kind === "buy_canary_fleet"
          ? "Cayden cannot approve a purchase. Josh: tap the button — it opens a confirm page. That buys two domains, three inboxes each (one Google, one Outlook). Warmup stays off. They send campaign copy in placement tests and stay off live campaigns. Nothing is bought until you confirm on that page."
          : details.kind === "generic_backfill"
            ? "Josh: tap Allow generics (opens a confirm page) to let pool generics backfill this campaign. Cayden cannot approve this."
          : details.kind === "add_signature_tag"
            ? "Josh or Cayden: tap Add %signature% (opens a confirm page). I will append the tag to the steps that are missing it and change nothing else. The campaign stays blocked until the tag exists."
          : details.kind === "retire_domain"
            ? "Josh: tap the button (opens a confirm page) to retire. One tap pulls every inbox on that domain, buys a replacement domain with matching Google/Outlook mix, and lets generics cover the campaigns until those warm (D150). Cayden cannot approve this."
            : "Josh or Cayden: *Use suggested edit* applies the suggestion above fleet-wide (D133). *Write my own edit* opens a Slack form that shows the exact phrase again so you can type a different replacement.",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const approveValue = isolationActionValue(
      details.kind,
      details.actionId,
      "approve",
    );
    const denyValue = isolationActionValue(details.kind, details.actionId, "deny");
    const editValue = isolationActionValue(
      details.kind,
      details.actionId,
      "edit",
    );
    const secret = this.creds.actionLinkSecret?.trim();
    const base = this.creds.publicBaseUrl?.trim();
    const approveUrl =
      secret && base
        ? slackActionHref({
            baseUrl: base,
            secret,
            id: details.actionId,
            decision: "approve",
          })
        : undefined;
    const denyUrl =
      secret && base
        ? slackActionHref({
            baseUrl: base,
            secret,
            id: details.actionId,
            decision: "deny",
          })
        : undefined;
    const kind = slackKindForIsolationAction(details.kind);
    if (!kind) {
      console.log(
        `[slack-quiet] dropped isolation ${details.kind}: ${details.title}`,
      );
      return;
    }
    const elements: Array<Record<string, unknown>> = [
      {
        type: "button",
        text: { type: "plain_text", text: approveLabel },
        style: "primary",
        action_id: "isolation_approve",
        value: approveValue,
        ...(approveUrl ? { url: approveUrl } : {}),
      },
    ];
    // D153 — native interactive button (no url). URL buttons skip
    // /slack/interactions, so they cannot open a modal.
    if (details.kind === "swap_copy" && findPhrase) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "Write my own edit" },
        action_id: SWAP_EDIT_ACTION_ID,
        value: editValue,
      });
    }
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Not now" },
      action_id: "isolation_deny",
      value: denyValue,
      ...(denyUrl ? { url: denyUrl } : {}),
    });
    await this.send(
      text,
      [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
        {
          type: "actions",
          elements,
        },
      ],
      kind,
    );
  }

  async notifyLeadRunout(details: { text: string }): Promise<void> {
    await this.send(details.text);
  }

  async notifySendingInfra(details: { text: string }): Promise<void> {
    await this.send(details.text);
  }
}
