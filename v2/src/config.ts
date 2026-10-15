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
  role: z
    .string()
    .default("all")
    .transform((s) => s.trim().toLowerCase())
    .pipe(z.enum(["api", "staff", "isolation", "all"])),
  port: z.coerce.number().int().positive().default(8080),
  databaseUrl: z.string().default(""),
  /**
   * HARD SHADOW is on by default. The only cutover switch is WRITE_ENABLED.
   * Writes require WRITE_ENABLED=true AND SHADOW=false.
   */
  shadow: boolFromEnv(true),
  writeEnabled: boolFromEnv(false),
  requireSpendApproval: boolFromEnv(true),
  /** D15 — monthly caps. Shadow never spends; cutover still honours these. */
  spendCapDomainUsd: z.coerce.number().positive().default(25),
  spendCapMailboxes: z.coerce.number().int().positive().default(25),
  smartleadApiKey: z.string().default(""),
  smartDeliveryApiKey: z.string().default(""),
  inboxkitApiKey: z.string().default(""),
  slackBotToken: z.string().default(""),
  slackChannelId: z.string().default(""),
  oldWizardHealthUrl: z
    .string()
    .default("https://deliverabilitywizard-production.up.railway.app/health"),
  runToken: z.string().default(""),
  poolWarmupDays: z.coerce.number().int().positive().default(21),
  campaignMinWarmupDays: z.coerce.number().int().positive().default(21),
  freshInboxWarmupDays: z.coerce.number().int().positive().default(21),
  remediationInboxThreshold: z.coerce.number().min(0).max(100).default(80),
  launchBar: z.coerce.number().min(0).max(100).default(85),
  bounceRateThreshold: z.coerce.number().min(0).max(100).default(5),
  bounceSampleFloor: z.coerce.number().int().positive().default(50),
  bounceWarnPercent: z.coerce.number().min(0).max(100).default(2),
  scoreSameEspOnly: boolFromEnv(true),
  minSameEspSamples: z.coerce.number().int().positive().default(3),
  totalTestQuota: z.coerce.number().int().nonnegative().default(0),
  maxMailboxesPerTest: z.coerce.number().int().positive().max(50).default(50),
  messagePerDay: z.coerce.number().int().positive().default(30),
  minTimeBtwEmails: z.coerce.number().int().positive().default(10),
  azureCampaignPerDay: z.coerce.number().int().positive().default(2),
  azureWarmupPerDay: z.coerce.number().int().positive().default(5),
  m365CampaignPerDay: z.coerce.number().int().positive().default(15),
  defaultMinFloor: z.coerce.number().int().positive().default(40),
  techevoClientId: z.coerce.number().int().positive().default(521881),
  techevoMinFloor: z.coerce.number().int().positive().default(30),
  pocFillSeats: z.coerce.number().int().positive().default(60),
  isolationDeadlineMs: z.coerce.number().int().positive().default(30 * 60 * 1000),
  isolationTickMs: z.coerce.number().int().positive().default(15 * 60 * 1000),
  prewarmedDomains: z
    .string()
    .default("crosslaunchco.com,crossscaleco.com,cleartechco.com")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  extraGenericDomains: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  canaryFleetEmails: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter((x) => x.includes("@")),
    ),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse({
    role: env.ROLE,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    shadow: env.SHADOW,
    writeEnabled: env.WRITE_ENABLED,
    requireSpendApproval: env.REQUIRE_SPEND_APPROVAL,
    spendCapDomainUsd: env.SPEND_CAP_DOMAIN_USD,
    spendCapMailboxes: env.SPEND_CAP_MAILBOXES,
    smartleadApiKey: env.SMARTLEAD_API_KEY,
    smartDeliveryApiKey: env.SMARTDELIVERY_API_KEY,
    inboxkitApiKey: env.INBOXKIT_API_KEY,
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackChannelId: env.SLACK_CHANNEL_ID,
    oldWizardHealthUrl: env.OLD_WIZARD_HEALTH_URL,
    runToken: env.RUN_TOKEN,
    poolWarmupDays: env.POOL_WARMUP_DAYS,
    campaignMinWarmupDays: env.MIN_CAMPAIGN_WARMUP_DAYS,
    freshInboxWarmupDays: env.FRESH_INBOX_WARMUP_DAYS,
    remediationInboxThreshold: env.REMEDIATION_INBOX_THRESHOLD,
    launchBar: env.LAUNCH_BAR,
    bounceRateThreshold: env.BOUNCE_RATE_THRESHOLD,
    bounceSampleFloor: env.BOUNCE_SAMPLE_FLOOR,
    bounceWarnPercent: env.BOUNCE_WARN_PERCENT,
    scoreSameEspOnly: env.SCORE_SAME_ESP_ONLY,
    minSameEspSamples: env.MIN_SAME_ESP_SAMPLES,
    totalTestQuota: env.TOTAL_TEST_QUOTA,
    maxMailboxesPerTest: env.MAX_MAILBOXES_PER_TEST,
    messagePerDay: env.MESSAGE_PER_DAY,
    minTimeBtwEmails: env.MIN_TIME_BTW_EMAILS,
    azureCampaignPerDay: env.AZURE_CAMPAIGN_PER_DAY,
    azureWarmupPerDay: env.AZURE_WARMUP_PER_DAY,
    m365CampaignPerDay: env.M365_CAMPAIGN_PER_DAY,
    defaultMinFloor: env.DEFAULT_MIN_FLOOR,
    techevoClientId: env.TECHEVO_CLIENT_ID,
    techevoMinFloor: env.TECHEVO_MIN_FLOOR,
    pocFillSeats: env.POC_FILL_SEATS,
    isolationDeadlineMs: env.ISOLATION_DEADLINE_MS,
    isolationTickMs: env.ISOLATION_TICK_MS,
    prewarmedDomains: env.PREWARMED_DOMAINS,
    extraGenericDomains: env.EXTRA_GENERIC_DOMAINS,
    canaryFleetEmails: env.CANARY_FLEET_EMAILS,
  });
}

/** Writes only when the single cutover flag is on AND shadow is explicitly off. */
export function writesAllowed(config: AppConfig): boolean {
  return config.writeEnabled === true && config.shadow === false;
}
