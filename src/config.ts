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
  totalTestQuota: z.coerce.number().int().positive().default(120),
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
  enableRemediation: boolFromEnv(false),
  /** Score Gmail→G Suite / Outlook→O365 only (matches ESP-matched campaigns). */
  scoreSameEspOnly: boolFromEnv(true),
  /** Min same-ESP seed hits before trusting same-ESP % (else fall back to all-ESP). */
  minSameEspSamples: z.coerce.number().int().positive().default(3),
  /** Warm a pulled inbox this long before it may go back on campaigns (2 weeks). */
  recoveryHoldDays: z.coerce.number().int().positive().default(14),
  /** Pull a sender off campaigns above this bounce rate (percent). */
  /** Every active campaign should carry at least this many senders. */
  minCampaignSenders: z.coerce.number().int().min(0).default(30),
  bounceRateThreshold: z.coerce.number().min(0).max(100).default(5),
  /** Minimum sends before a bounce rate is treated as evidence. */
  minBounceSample: z.coerce.number().int().min(0).default(50),
  enableBounceRotation: boolFromEnv(true),
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
  /** Sub in warmed generics while originals recover (requires pool inventory in state). */
  enableRecoveryPool: boolFromEnv(false),
  /** Days of Smartlead-only warmup before a generic is free for swaps. */
  poolWarmupDays: z.coerce.number().int().positive().default(14),
  /**
   * Pull mailboxes off ACTIVE campaigns until they have warmed this many days.
   * Also strips active HOLD-UNTIL-* tagged accounts from ACTIVE campaigns.
   */
  enableWarmupGate: boolFromEnv(true),
  campaignMinWarmupDays: z.coerce.number().int().positive().default(14),
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
    totalTestQuota: env.TOTAL_TEST_QUOTA ?? "120",
    maxMailboxesPerTest: env.MAX_MAILBOXES_PER_TEST ?? "50",
    autoPlacementTests: env.AUTO_PLACEMENT_TESTS,
    placementTestEveryDays: env.PLACEMENT_TEST_EVERY_DAYS ?? "1",
    placementTestEndDays: env.PLACEMENT_TEST_END_DAYS ?? "0",
    autoTestActiveStatuses: env.AUTO_TEST_ACTIVE_STATUSES ?? "ACTIVE",
    enableTestReconciler: env.ENABLE_TEST_RECONCILER,
    deliverabilityThreshold: env.DELIVERABILITY_THRESHOLD ?? "90",
    remediationInboxThreshold: env.REMEDIATION_INBOX_THRESHOLD ?? "80",
    enableRemediation: env.ENABLE_REMEDIATION,
    scoreSameEspOnly: env.SCORE_SAME_ESP_ONLY,
    minSameEspSamples: env.MIN_SAME_ESP_SAMPLES ?? "3",
    recoveryHoldDays: env.RECOVERY_HOLD_DAYS ?? "14",
    minCampaignSenders: env.MIN_CAMPAIGN_SENDERS ?? "30",
    bounceRateThreshold: env.BOUNCE_RATE_THRESHOLD ?? "5",
    minBounceSample: env.MIN_BOUNCE_SAMPLE ?? "50",
    enableBounceRotation: env.ENABLE_BOUNCE_ROTATION,
    extraGenericMailboxes:
      env.EXTRA_GENERIC_MAILBOXES ?? "harmony norris,breanna escobar",
    enableRecoveryPool: env.ENABLE_RECOVERY_POOL,
    poolWarmupDays: env.POOL_WARMUP_DAYS ?? "14",
    enableWarmupGate: env.ENABLE_WARMUP_GATE,
    campaignMinWarmupDays: env.MIN_CAMPAIGN_WARMUP_DAYS ?? "14",
    clientDomainBudgetUsd: env.CLIENT_DOMAIN_BUDGET_USD ?? "25",
    clientMailboxMonthlyCap: env.CLIENT_MAILBOX_MONTHLY_CAP ?? "25",
    warmupTotalPerDay: env.WARMUP_TOTAL_PER_DAY ?? "20",
    warmupDailyRampup: env.WARMUP_DAILY_RAMPUP ?? "5",
    warmupReplyRatePercentage: env.WARMUP_REPLY_RATE_PERCENTAGE ?? "30",
    campaignStatuses: env.CAMPAIGN_STATUSES ?? "ACTIVE,PAUSED",
    cronScan: env.CRON_SCAN ?? "0 9 * * 1,4",
    cronMonitor: env.CRON_MONITOR ?? "0 */6 * * *",
    providerIds: env.PROVIDER_IDS ?? "",
    sequenceNumber: env.SEQUENCE_NUMBER ?? "1",
    stateFilePath: env.STATE_FILE_PATH ?? "/data/state.json",
    port: env.PORT ?? "3000",
    host: env.HOST ?? "0.0.0.0",
    runToken: env.RUN_TOKEN ?? "",
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
