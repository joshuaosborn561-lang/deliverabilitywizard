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
  totalTestQuota: z.coerce.number().int().positive().default(120),
  maxMailboxesPerTest: z.coerce.number().int().positive().max(50).default(50),
  deliverabilityThreshold: z.coerce.number().min(0).max(100).default(90),
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
    totalTestQuota: env.TOTAL_TEST_QUOTA ?? "120",
    maxMailboxesPerTest: env.MAX_MAILBOXES_PER_TEST ?? "50",
    deliverabilityThreshold: env.DELIVERABILITY_THRESHOLD ?? "90",
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
