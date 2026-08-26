import { z } from "zod";

const boolFromEnv = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return fallback;
      return ["1", "true", "yes", "on"].includes(v.toLowerCase());
    });

const ConfigSchema = z.object({
  smartleadApiKey: z.string().default(""),
  smartDeliveryApiKey: z.string().default(""),
  slackWebhookUrl: z.string().default(""),
  slackBotToken: z.string().default(""),
  slackChannelId: z.string().default(""),
  slackChannel: z.string().default("#deliverability"),
  slackClientId: z.string().default(""),
  slackClientSecret: z.string().default(""),
  slackBotTokenFile: z.string().default("/data/slack-bot-token"),
  slackOauthRedirectUri: z.string().default(
    "https://deliverabilitywizard-production.up.railway.app/slack/oauth",
  ),
  inboxkitApiKey: z.string().default(""),
  inboxkitWorkspaceId: z.string().default(""),
  /** Dedicated InboxKit workspace for the 75 generic recovery-pool mailboxes */
  genericPoolWorkspaceId: z.string().default(""),
  porkbunApiKey: z.string().default(""),
  porkbunSecretApiKey: z.string().default(""),
  /** Self-advancing cron that polls NS → buy → export → warmup → ready */
  enablePoolProvisioner: boolFromEnv(true),
  cronPoolProvision: z.string().default("*/30 * * * *"),
  /**
   * Approval gateway: when true (default), any real-money/wallet spend
   * (currently InboxKit mailbox purchases) is held as "pending" and Slack-
   * notified instead of executed, until a human approves it via
   * POST /approvals/:id/approve. Do not disable unless fully unattended
   * spend is acceptable.
   */
  requireSpendApproval: boolFromEnv(true),
  /**
   * Daily reconnect of disconnected Smartlead accounts (SMTP/IMAP fail).
   * Cron runs in America/New_York so "3am EST" tracks EST/EDT.
   */
  enableAccountReconnect: boolFromEnv(true),
  cronAccountReconnect: z.string().default("0 3 * * *"),
  /** InboxKit→Smartlead sequencer login (one-time; password not the API key) */
  smartleadLoginEmail: z.string().default(""),
  smartleadLoginPassword: z.string().default(""),
  /**
   * Concurrent SmartDelivery test cap. 0 = unlimited (D45). A positive
   * value still blocks scanner / held / rest creates (old D8 behaviour).
   * Do not set Railway TOTAL_TEST_QUOTA=0 until this code is on main —
   * older deploys reject 0 via `.positive()`.
   */
  totalTestQuota: z.coerce.number().int().nonnegative().default(0),
  maxMailboxesPerTest: z.coerce.number().int().positive().max(50).default(50),
  /**
   * Create recurring (automated) placement tests instead of one-off manual
   * tests, so a campaign keeps being tested while it is live.
   */
  autoPlacementTests: boolFromEnv(true),
  /** Recurrence interval for automated placement tests (1 = daily). */
  placementTestEveryDays: z.coerce.number().int().positive().default(1),
  /**
   * Optional hard stop for a schedule, in days from creation. 0 = open-ended
   * (the reconciler stops it when the campaign goes inactive).
   */
  placementTestEndDays: z.coerce.number().int().nonnegative().default(0),
  /**
   * Campaign statuses that keep an automated test running. A test whose
   * campaign leaves this set is stopped by the reconciler.
   */
  autoTestActiveStatuses: z
    .string()
    .default("ACTIVE")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean),
    ),
  /** Stop automated tests whose campaign is no longer active. */
  enableTestReconciler: boolFromEnv(true),
  deliverabilityThreshold: z.coerce.number().min(0).max(100).default(90),
  remediationInboxThreshold: z.coerce.number().min(0).max(100).default(80),
  /** Score Gmail→G Suite / Outlook→O365 only (matches ESP-matched campaigns). */
  scoreSameEspOnly: boolFromEnv(true),
  /** Min same-ESP seed hits before trusting same-ESP %. Below that, skip placement rotation (D32). */
  minSameEspSamples: z.coerce.number().int().positive().default(3),
  /** Every active campaign should carry at least this many *staffable* senders. */
  minCampaignSenders: z.coerce.number().int().min(0).default(50),
  /**
   * D81 — POC clients (Goliath today) may receive generics without a
   * per-campaign Slack tap. Everyone else needs Josh's Slack approve.
   */
  pocClientNamePatterns: z
    .string()
    .default("goliath")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  enableCampaignTopUp: boolFromEnv(true),
  /**
   * Fast staffing loop: reconnect → mailbox settings → refill/unpause.
   * Measure (placement/remediation/DNS) stays on the slower monitor cron.
   */
  enableCampaignHealth: boolFromEnv(true),
  /**
   * D81 — first-seen campaign audit + hourly sweep (pods, sigs, canaries).
   * Does not START, import leads, or spend. Slack only to ask Josh to
   * approve generic backfill.
   */
  enableCampaignCheck: boolFromEnv(true),
  cronCampaignCheck: z.string().default("0 * * * *"),
  /**
   * D43 — 2 weeks on / 2 weeks off for client inboxes, split A/B per client.
   */
  enableClientRest: boolFromEnv(true),
  /**
   * D43 — generics sit after this many days of live campaign send, then
   * become supply again after the same sit. Not the client A/B fortnight.
   */
  enableGenericSendRest: boolFromEnv(true),
  genericSendRestDays: z.coerce.number().int().positive().default(14),
  /**
   * D48 — standing per-pod control tests (fixed control email, per-sender
   * read). Tests are unlimited (D45); this does not wait for seed approval.
   */
  enablePodControls: boolFromEnv(true),
  /**
   * D56 — pinned Smartlead id for the paused known-good shell. 0 means
   * find-or-create by name (`Pod control shell`).
   */
  podControlShellCampaignId: z.coerce.number().int().nonnegative().default(0),
  /** Low-rep isolation domain weekly baseline + copy teardown senders. */
  enableIsolationRig: boolFromEnv(true),
  /** Infra-vs-copy lookup from standing controls. */
  enableIsolationBranch: boolFromEnv(true),
  /** One-variable copy teardown; starts on its own when the verdict is copy. */
  enableCopyIsolation: boolFromEnv(true),
  /** Daily replies + out-of-office collapse watch. */
  enableDeliveryWatch: boolFromEnv(true),
  /**
   * D52 — Slack when an ACTIVE campaign is halfway / three-quarters /
   * out of leads. Never imports. Campaign audit does not watch this number.
   */
  enableLeadRunout: boolFromEnv(true),
  /**
   * D53 — one census of sending IPs from placement reports we already pull.
   */
  enableSendingInfraCensus: boolFromEnv(true),
  isolationDomain: z.string().default(""),
  isolationMailboxIds: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  isolationMailboxEmails: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  isolationVariantCap: z.coerce.number().int().positive().max(20).default(8),
  cronDeliveryWatch: z.string().default("0 13 * * *"),
  /** Slack signing secret so button clicks can be verified. */
  slackSigningSecret: z.string().default(""),
  slackJoshUserIds: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  slackCaydenUserIds: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  isolationBuyParentDomain: z.string().default("crosslaunchco.com"),
  isolationMailboxesPerBuyDomain: z.coerce.number().int().positive().max(10).default(3),
  /** Minimum share of each ESP (Google / Microsoft) when topping up to 50. */
  campaignEspMixMinPercent: z.coerce.number().int().min(0).max(50).default(30),
  cronHealth: z.string().default("*/15 * * * *"),
  /** Daily campaign send cap held on every mailbox (warmups not included). */
  messagePerDay: z.coerce.number().int().min(1).default(30),
  /**
   * Minimum minutes between sends on every mailbox (Smartlead
   * `time_to_wait_in_mins` / UI "Minimum time gap"). D30.
   */
  mailboxMinTimeGapMins: z.coerce.number().int().min(0).default(10),
  enforceMailboxSettings: boolFromEnv(true),
  /** Campaign ids or name fragments never topped up automatically. */
  topUpExcludeCampaigns: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((x) => x.trim()).filter(Boolean)),
  /** Leftover D5 reading. D79 retired the per-sender pull; do not treat this as live. */
  bounceRateThreshold: z.coerce.number().min(0).max(100).default(5),
  /**
   * D41 — Slack/investigate warn. Does not rotate.
   * D79 retired D5's per-sender 5%/50 pull; this 5% is a leftover reading.
   */
  bounceRateWarnThreshold: z.coerce.number().min(0).max(100).default(2),
  /**
   * D80 — after our autostop has scanned, write Smartlead
   * bounce_autopause_threshold to 100 (off). Not a rule to turn it on.
   */
  enableBounceAutopauseConverge: boolFromEnv(true),
  smartleadBounceAutopauseOffPercent: z.coerce
    .number()
    .min(1)
    .max(100)
    .default(100),
  /** D80 — our campaign bounce pause. Smartlead's own autopause stays off. */
  enableCampaignBounceAutostop: boolFromEnv(true),
  cronBounceAutostop: z.string().default("*/10 * * * *"),
  /**
   * D90 — live pause: over 10% bounce after 1k leads emailed, or more
   * than 10 new bounces in the last 10 minutes (D88 retired the 20/7 bands).
   */
  bouncePauseMinLeads: z.coerce.number().int().min(0).default(1000),
  bouncePauseRatePercent: z.coerce.number().min(0).max(100).default(10),
  bounceBurstCount: z.coerce.number().int().min(0).default(10),
  /** Minimum sends before a bounce rate is treated as evidence. */
  minBounceSample: z.coerce.number().int().min(0).default(50),
  /**
   * D51 — keep this many still-warming pool generics on each ACTIVE campaign
   * sending the live sequence (extra to the 50 staffable floor).
   */
  enableCopyCanary: boolFromEnv(true),
  copyCanaryPerCampaign: z.coerce.number().int().min(0).max(10).default(3),
  /**
   * Pre-warmed generic mailboxes that live outside the .info pool plan, matched
   * against Smartlead by email address or by from_name (e.g. "Harmony Norris").
   *
   * These are registered as swap-ready pool generics AND exempted from the
   * warmup gate's minimum-warmup rule — they are already warm, so Smartlead's
   * warmup start date must not be used to pull them off live campaigns.
   * Comma-separated.
   */
  extraGenericMailboxes: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Explicit domains whose whole fleet was purchased pre-warmed. */
  extraGenericDomains: z
    .string()
    .default("crosslaunchco.com,crossscaleco.com,cleartechco.com")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  /**
   * Days from InboxKit import before a generic is free for live send / swaps.
   * Clock is `warmedAt` at import, not Smartlead's warmup record (D1).
   * Duration is 21 days (D50; superseded D1's 14).
   */
  poolWarmupDays: z.coerce.number().int().positive().default(21),
  /**
   * D105 — 21-day live-send gate is on. Canary fleet and pre-warmed
   * fleets stay exempt. Placement / bounce pulls stay off (D51).
   */
  enableWarmupGate: boolFromEnv(true),
  /**
   * D106 — same-ESP inbox % a campaign needs before auto-START
   * (qa-unpause). Morning activate (D109) ignores this once.
   */
  launchInboxThreshold: z.coerce.number().min(0).max(100).default(85),
  /** D107 — leftover old-client campaigns to delete. */
  oldClientCampaignIds: z
    .string()
    .default("3437329,3628940,3628943")
    .transform((s) =>
      s
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  campaignMinWarmupDays: z.coerce.number().int().positive().default(21),
  /**
   * D41 — non-prewarmed (fresh InboxKit) inboxes owe this many days before
   * a live campaign. Pre-warmed fleets stay exempt. D50 aligned the pool
   * and campaign-min clocks to the same 21 days.
   */
  freshInboxWarmupDays: z.coerce.number().int().positive().default(21),
  /** Porkbun domain spend cap per client per UTC month (USD). */
  clientDomainBudgetUsd: z.coerce.number().nonnegative().default(25),
  /** New mailboxes per client per UTC month (blacklist replace). */
  clientMailboxMonthlyCap: z.coerce.number().int().nonnegative().default(25),
  warmupTotalPerDay: z.coerce.number().int().positive().default(20),
  warmupDailyRampup: z.coerce.number().int().positive().default(5),
  warmupReplyRatePercentage: z.coerce.number().int().positive().default(30),
  campaignStatuses: z
    .string()
    .default("ACTIVE,PAUSED")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean),
    ),
  cronScan: z.string().default("0 9 * * 1,4"),
  cronMonitor: z.string().default("0 */6 * * *"),
  /**
   * Fleet send-volume report. Runs on its own schedule rather than with the
   * monitor: the number is only meaningful once the day has some sending in
   * it, and a 6-hourly post would report an empty day twice each morning.
   *
   * Pipe-separated because cron already uses commas inside a field. Runs in
   * America/New_York so midday tracks EST/EDT.
   */
  cronSendVolume: z.string().default("0 12 * * *|30 16 * * *"),
  providerIds: z
    .string()
    .optional()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n)),
    ),
  sequenceNumber: z.coerce.number().int().positive().default(1),
  stateFilePath: z.string().default("/data/state.json"),
  port: z.coerce.number().int().positive().default(3000),
  host: z.string().default("0.0.0.0"),
  runToken: z.string().optional().default(""),
  /** Authenticated human operations console at /ops. */
  opsUiEnabled: boolFromEnv(false),
  opsOwnerUsername: z.string().min(1).default("josh"),
  opsOperatorUsername: z.string().min(1).default("cayden"),
  opsOwnerToken: z.string().default(""),
  opsOperatorToken: z.string().default(""),
  opsSessionSecret: z.string().default(""),
  opsSessionHours: z.coerce.number().int().positive().max(168).default(12),
  /**
   * Cursor Cloud Agents API key for freeform /ops chat (Grok 4.5 High Fast).
   * When empty, unrecognized chat stays on the local allowlist help text.
   */
  cursorApiKey: z.string().default(""),
  /** GitHub HTTPS URL the Ops Cursor agent works in. */
  cursorAgentRepositoryUrl: z
    .string()
    .default("https://github.com/joshuaosborn561-lang/deliverabilitywizard"),
  cursorAgentStartingRef: z.string().default("main"),
  /** Model id from GET https://api.cursor.com/v1/models */
  cursorAgentModelId: z.string().default("grok-4.5"),
  /**
   * Comma-separated model params as id=value (e.g. effort=high,fast=true).
   * Default is Cursor Grok 4.5 High Fast.
   */
  cursorAgentModelParams: z
    .string()
    .default("effort=high,fast=true")
    .transform((s) =>
      s
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const eq = part.indexOf("=");
          if (eq <= 0) return null;
          return {
            id: part.slice(0, eq).trim(),
            value: part.slice(eq + 1).trim(),
          };
        })
        .filter(
          (p): p is { id: string; value: string } =>
            Boolean(p && p.id && p.value),
        ),
    ),
  /** Max wait for one Cursor agent turn before telling the UI to open the agent URL. */
  cursorAgentTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(480_000),
  /**
   * When true (default) and CURSOR_API_KEY is set, repeated code-class failures
   * launch a Cursor Cloud Agent that opens a fix PR (D21). Never spends/deletes.
   */
  enableBugRemediator: boolFromEnv(true),
  /** Hits of the same fingerprint before launching a Cursor agent. */
  bugRemediatorMinHits: z.coerce.number().int().positive().default(2),
  /** Hours to wait before re-launching for the same fingerprint. */
  bugRemediatorCooldownHours: z.coerce.number().int().positive().default(24),
  /**
   * When true, the Cursor remediator is told to merge the PR after CI is green
   * so Josh does not have to. Default on — still cannot spend/delete/bypass.
   */
  bugRemediatorAutoMerge: boolFromEnv(true),
  dryRun: boolFromEnv(false),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const smartleadApiKey = env.SMARTLEAD_API_KEY ?? "";
  const smartDeliveryApiKey =
    env.SMARTDELIVERY_API_KEY?.trim() || smartleadApiKey;

  const parsed = ConfigSchema.safeParse({
    smartleadApiKey,
    smartDeliveryApiKey,
    slackWebhookUrl: env.SLACK_WEBHOOK_URL ?? "",
    slackBotToken: env.SLACK_BOT_TOKEN ?? "",
    slackChannelId: env.SLACK_CHANNEL_ID ?? "",
    slackChannel: env.SLACK_CHANNEL ?? env.SLACK_CHANNEL_ID ?? "#deliverability",
    slackClientId: env.SLACK_CLIENT_ID ?? "",
    slackClientSecret: env.SLACK_CLIENT_SECRET ?? "",
    slackBotTokenFile: env.SLACK_BOT_TOKEN_FILE ?? "/data/slack-bot-token",
    slackOauthRedirectUri:
      env.SLACK_OAUTH_REDIRECT_URI ??
      "https://deliverabilitywizard-production.up.railway.app/slack/oauth",
    inboxkitApiKey: env.INBOXKIT_API_KEY ?? "",
    inboxkitWorkspaceId: env.INBOXKIT_WORKSPACE_ID ?? "",
    genericPoolWorkspaceId:
      env.GENERIC_POOL_WORKSPACE_ID ??
      env.INBOXKIT_GENERIC_POOL_WORKSPACE_ID ??
      "",
    porkbunApiKey: env.PORKBUN_API_KEY ?? "",
    porkbunSecretApiKey: env.PORKBUN_SECRET_API_KEY ?? "",
    enablePoolProvisioner: env.ENABLE_POOL_PROVISIONER,
    cronPoolProvision: env.CRON_POOL_PROVISION ?? "*/30 * * * *",
    requireSpendApproval: env.REQUIRE_SPEND_APPROVAL,
    enableAccountReconnect: env.ENABLE_ACCOUNT_RECONNECT,
    cronAccountReconnect: env.CRON_ACCOUNT_RECONNECT ?? "0 3 * * *",
    smartleadLoginEmail: env.SMARTLEAD_LOGIN_EMAIL ?? "",
    smartleadLoginPassword: env.SMARTLEAD_LOGIN_PASSWORD ?? "",
    totalTestQuota: env.TOTAL_TEST_QUOTA ?? "0",
    maxMailboxesPerTest: env.MAX_MAILBOXES_PER_TEST ?? "50",
    autoPlacementTests: env.AUTO_PLACEMENT_TESTS,
    placementTestEveryDays: env.PLACEMENT_TEST_EVERY_DAYS ?? "1",
    placementTestEndDays: env.PLACEMENT_TEST_END_DAYS ?? "0",
    autoTestActiveStatuses: env.AUTO_TEST_ACTIVE_STATUSES ?? "ACTIVE",
    enableTestReconciler: env.ENABLE_TEST_RECONCILER,
    deliverabilityThreshold: env.DELIVERABILITY_THRESHOLD ?? "90",
    remediationInboxThreshold: env.REMEDIATION_INBOX_THRESHOLD ?? "80",
    scoreSameEspOnly: env.SCORE_SAME_ESP_ONLY,
    minSameEspSamples: env.MIN_SAME_ESP_SAMPLES ?? "3",
    minCampaignSenders: env.MIN_CAMPAIGN_SENDERS ?? "50",
    pocClientNamePatterns: env.POC_CLIENT_NAME_PATTERNS ?? "goliath",
    enableCampaignTopUp: env.ENABLE_CAMPAIGN_TOP_UP,
    enableCampaignHealth: env.ENABLE_CAMPAIGN_HEALTH,
    enableCampaignCheck: env.ENABLE_CAMPAIGN_CHECK,
    cronCampaignCheck: env.CRON_CAMPAIGN_CHECK ?? "0 * * * *",
    enableClientRest: env.ENABLE_CLIENT_REST,
    enableGenericSendRest: env.ENABLE_GENERIC_SEND_REST,
    genericSendRestDays: env.GENERIC_SEND_REST_DAYS ?? "14",
    enablePodControls: env.ENABLE_POD_CONTROLS,
    podControlShellCampaignId: env.POD_CONTROL_SHELL_CAMPAIGN_ID ?? "0",
    enableIsolationRig: env.ENABLE_ISOLATION_RIG,
    enableIsolationBranch: env.ENABLE_ISOLATION_BRANCH,
    enableCopyIsolation: env.ENABLE_COPY_ISOLATION,
    enableDeliveryWatch: env.ENABLE_DELIVERY_WATCH,
    enableLeadRunout: env.ENABLE_LEAD_RUNOUT,
    enableSendingInfraCensus: env.ENABLE_SENDING_INFRA_CENSUS,
    isolationDomain: env.ISOLATION_DOMAIN ?? "",
    isolationMailboxIds: env.ISOLATION_MAILBOX_IDS ?? "",
    isolationMailboxEmails: env.ISOLATION_MAILBOX_EMAILS ?? "",
    isolationVariantCap: env.ISOLATION_VARIANT_CAP ?? "8",
    cronDeliveryWatch: env.CRON_DELIVERY_WATCH ?? "0 13 * * *",
    slackSigningSecret: env.SLACK_SIGNING_SECRET ?? "",
    slackJoshUserIds: env.SLACK_JOSH_USER_ID ?? "",
    slackCaydenUserIds: env.SLACK_CAYDEN_USER_ID ?? "",
    isolationBuyParentDomain:
      env.ISOLATION_BUY_PARENT_DOMAIN ?? "crosslaunchco.com",
    isolationMailboxesPerBuyDomain: env.ISOLATION_MAILBOXES_PER_BUY_DOMAIN ?? "3",
    campaignEspMixMinPercent: env.CAMPAIGN_ESP_MIX_MIN_PERCENT ?? "30",
    cronHealth: env.CRON_HEALTH ?? "*/15 * * * *",
    messagePerDay: env.MESSAGE_PER_DAY ?? "30",
    mailboxMinTimeGapMins: env.MAILBOX_MIN_TIME_GAP_MINS ?? "10",
    enforceMailboxSettings: env.ENFORCE_MAILBOX_SETTINGS,
    topUpExcludeCampaigns: env.TOP_UP_EXCLUDE_CAMPAIGNS ?? "",
    bounceRateThreshold: env.BOUNCE_RATE_THRESHOLD ?? "5",
    bounceRateWarnThreshold: env.BOUNCE_RATE_WARN_THRESHOLD ?? "2",
    enableBounceAutopauseConverge: env.ENABLE_BOUNCE_AUTOPAUSE_CONVERGE,
    smartleadBounceAutopauseOffPercent:
      env.SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT ?? "100",
    enableCampaignBounceAutostop: env.ENABLE_CAMPAIGN_BOUNCE_AUTOSTOP,
    cronBounceAutostop: env.CRON_BOUNCE_AUTOSTOP ?? "*/10 * * * *",
    bouncePauseMinLeads: env.BOUNCE_PAUSE_MIN_LEADS ?? "1000",
    bouncePauseRatePercent: env.BOUNCE_PAUSE_RATE_PERCENT ?? "10",
    bounceBurstCount: env.BOUNCE_BURST_COUNT ?? "10",
    minBounceSample: env.MIN_BOUNCE_SAMPLE ?? "50",
    enableCopyCanary: env.ENABLE_COPY_CANARY,
    copyCanaryPerCampaign: env.COPY_CANARY_PER_CAMPAIGN ?? "3",
    extraGenericMailboxes:
      env.EXTRA_GENERIC_MAILBOXES ?? "harmony norris,breanna escobar",
    extraGenericDomains:
      env.EXTRA_GENERIC_DOMAINS ??
      "crosslaunchco.com,crossscaleco.com,cleartechco.com",
    poolWarmupDays: env.POOL_WARMUP_DAYS ?? "21",
    enableWarmupGate: env.ENABLE_WARMUP_GATE,
    launchInboxThreshold: env.LAUNCH_INBOX_THRESHOLD ?? "85",
    oldClientCampaignIds: env.OLD_CLIENT_CAMPAIGN_IDS ?? "3437329,3628940,3628943",
    campaignMinWarmupDays: env.MIN_CAMPAIGN_WARMUP_DAYS ?? "21",
    freshInboxWarmupDays: env.FRESH_INBOX_WARMUP_DAYS ?? "21",
    clientDomainBudgetUsd: env.CLIENT_DOMAIN_BUDGET_USD ?? "25",
    clientMailboxMonthlyCap: env.CLIENT_MAILBOX_MONTHLY_CAP ?? "25",
    warmupTotalPerDay: env.WARMUP_TOTAL_PER_DAY ?? "20",
    warmupDailyRampup: env.WARMUP_DAILY_RAMPUP ?? "5",
    warmupReplyRatePercentage: env.WARMUP_REPLY_RATE_PERCENTAGE ?? "30",
    campaignStatuses: env.CAMPAIGN_STATUSES ?? "ACTIVE,PAUSED",
    cronScan: env.CRON_SCAN ?? "0 9 * * 1,4",
    cronMonitor: env.CRON_MONITOR ?? "0 */6 * * *",
    cronSendVolume: env.CRON_SEND_VOLUME ?? "0 12 * * *|30 16 * * *",
    providerIds: env.PROVIDER_IDS ?? "",
    sequenceNumber: env.SEQUENCE_NUMBER ?? "1",
    stateFilePath: env.STATE_FILE_PATH ?? "/data/state.json",
    port: env.PORT ?? "3000",
    host: env.HOST ?? "0.0.0.0",
    runToken: env.RUN_TOKEN ?? "",
    opsUiEnabled: env.OPS_UI_ENABLED,
    opsOwnerUsername: env.OPS_OWNER_USERNAME ?? "josh",
    opsOperatorUsername: env.OPS_OPERATOR_USERNAME ?? "cayden",
    opsOwnerToken: env.OPS_OWNER_TOKEN ?? "",
    opsOperatorToken: env.OPS_OPERATOR_TOKEN ?? "",
    opsSessionSecret: env.OPS_SESSION_SECRET ?? "",
    opsSessionHours: env.OPS_SESSION_HOURS ?? "12",
    cursorApiKey: env.CURSOR_API_KEY ?? "",
    cursorAgentRepositoryUrl:
      env.CURSOR_AGENT_REPOSITORY_URL ??
      "https://github.com/joshuaosborn561-lang/deliverabilitywizard",
    cursorAgentStartingRef: env.CURSOR_AGENT_STARTING_REF ?? "main",
    cursorAgentModelId: env.CURSOR_AGENT_MODEL_ID ?? "grok-4.5",
    cursorAgentModelParams:
      env.CURSOR_AGENT_MODEL_PARAMS ?? "effort=high,fast=true",
    cursorAgentTimeoutMs: env.CURSOR_AGENT_TIMEOUT_MS ?? "480000",
    enableBugRemediator: env.ENABLE_BUG_REMEDIATOR,
    bugRemediatorMinHits: env.BUG_REMEDIATOR_MIN_HITS ?? "2",
    bugRemediatorCooldownHours: env.BUG_REMEDIATOR_COOLDOWN_HOURS ?? "24",
    bugRemediatorAutoMerge: env.BUG_REMEDIATOR_AUTO_MERGE,
    dryRun: env.DRY_RUN,
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  return parsed.data;
}

export function assertRuntimeSecrets(config: AppConfig): void {
  const missing: string[] = [];
  if (!config.smartleadApiKey) missing.push("SMARTLEAD_API_KEY");
  if (!config.smartDeliveryApiKey) {
    missing.push("SMARTDELIVERY_API_KEY / SMARTLEAD_API_KEY");
  }
  const hasSlack =
    Boolean(config.slackWebhookUrl) ||
    (Boolean(config.slackBotToken) &&
      Boolean(config.slackChannelId || config.slackChannel));
  if (!hasSlack) {
    missing.push("SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN+SLACK_CHANNEL_ID");
  }
  if (missing.length) {
    throw new Error(
      `Missing required secrets: ${missing.join(", ")}. Set them as Railway environment variables.`,
    );
  }
}

export function configIsReady(config: AppConfig): boolean {
  try {
    assertRuntimeSecrets(config);
    return true;
  } catch {
    return false;
  }
}
