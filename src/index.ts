import express from "express";
import cron from "node-cron";
import { assertRuntimeSecrets, configIsReady, loadConfig } from "./config.js";
import { SmartleadClient } from "./clients/smartlead.js";
import { SmartDeliveryClient } from "./clients/smartdelivery.js";
import { InboxKitClient } from "./clients/inboxkit.js";
import { SlackClient } from "./clients/slack.js";
import { StateStore } from "./state/store.js";
import { CampaignScanner } from "./services/campaignScanner.js";
import { ResultMonitor } from "./services/resultMonitor.js";
import { RemediationService } from "./services/remediation.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const state = new StateStore(config.stateFilePath);
  await state.load();

  const secretsReady = configIsReady(config);
  if (!secretsReady) {
    console.warn(
      "[boot] SMARTLEAD_API_KEY and/or Slack credentials not set yet — HTTP health is up, scans will fail until secrets are configured.",
    );
  }

  const smartlead = new SmartleadClient(config.smartleadApiKey || "missing");
  const smartDelivery = new SmartDeliveryClient(
    config.smartDeliveryApiKey || "missing",
  );
  const inboxkit = config.inboxkitApiKey
    ? new InboxKitClient(config.inboxkitApiKey, config.inboxkitWorkspaceId || undefined)
    : null;
  const slack = new SlackClient({
    webhookUrl: config.slackWebhookUrl,
    botToken: config.slackBotToken,
    channelId: config.slackChannelId,
    channelLabel: config.slackChannel,
  });
  const scanner = new CampaignScanner(config, smartlead, smartDelivery, slack, state);
  const monitor = new ResultMonitor(config, smartDelivery, slack, state);
  const remediation = new RemediationService(
    config,
    smartlead,
    smartDelivery,
    inboxkit,
    slack,
    state,
  );

  let scanInFlight: Promise<unknown> | null = null;
  let monitorInFlight: Promise<unknown> | null = null;
  let remediationInFlight: Promise<unknown> | null = null;

  const runScan = async (trigger: "cron" | "manual") => {
    assertRuntimeSecrets(config);
    if (scanInFlight) {
      console.log("[scan] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    scanInFlight = scanner.run({ trigger }).finally(() => {
      scanInFlight = null;
    });
    return scanInFlight;
  };

  const runRemediation = async () => {
    assertRuntimeSecrets(config);
    if (remediationInFlight) {
      console.log("[remediation] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    remediationInFlight = remediation.run().finally(() => {
      remediationInFlight = null;
    });
    return remediationInFlight;
  };

  const runMonitor = async (opts: { remediate?: boolean } = {}) => {
    assertRuntimeSecrets(config);
    if (monitorInFlight) {
      console.log("[monitor] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    monitorInFlight = (async () => {
      const monitorResult = await monitor.run();
      const shouldRemediate =
        opts.remediate !== false &&
        (config.enableRemediation || config.dryRun);
      let remediationResult: unknown = null;
      if (shouldRemediate) {
        remediationResult = await runRemediation();
      }
      return { monitor: monitorResult, remediation: remediationResult };
    })().finally(() => {
      monitorInFlight = null;
    });
    return monitorInFlight;
  };

  if (!cron.validate(config.cronScan)) {
    throw new Error(`Invalid CRON_SCAN expression: ${config.cronScan}`);
  }
  if (!cron.validate(config.cronMonitor)) {
    throw new Error(`Invalid CRON_MONITOR expression: ${config.cronMonitor}`);
  }

  cron.schedule(config.cronScan, () => {
    void runScan("cron").catch((error) => {
      console.error("[scan] Unhandled cron error", error);
    });
  });

  cron.schedule(config.cronMonitor, () => {
    void runMonitor({ remediate: true }).catch((error) => {
      console.error("[monitor] Unhandled cron error", error);
    });
  });

  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    const s = state.get();
    res.json({
      ok: true,
      service: "deliverabilitywizard",
      secretsConfigured: secretsReady,
      remediationEnabled: config.enableRemediation,
      inboxkitConfigured: Boolean(config.inboxkitApiKey),
      lastScanAt: s.lastScanAt,
      lastMonitorAt: s.lastMonitorAt,
      lastRemediationAt: s.lastRemediationAt,
      testedCampaignCount: Object.keys(s.testedCampaigns).length,
      cronScan: config.cronScan,
      cronMonitor: config.cronMonitor,
      totalTestQuota: config.totalTestQuota,
      maxMailboxesPerTest: config.maxMailboxesPerTest,
      remediationInboxThreshold: config.remediationInboxThreshold,
    });
  });

  app.get("/status", (_req, res) => {
    res.json({
      state: state.get(),
      config: {
        campaignStatuses: config.campaignStatuses,
        cronScan: config.cronScan,
        cronMonitor: config.cronMonitor,
        totalTestQuota: config.totalTestQuota,
        maxMailboxesPerTest: config.maxMailboxesPerTest,
        deliverabilityThreshold: config.deliverabilityThreshold,
        remediationInboxThreshold: config.remediationInboxThreshold,
        enableRemediation: config.enableRemediation,
        inboxkitConfigured: Boolean(config.inboxkitApiKey),
        sequenceNumber: config.sequenceNumber,
        dryRun: config.dryRun,
      },
    });
  });

  app.post("/run", async (req, res) => {
    if (config.runToken) {
      const token = req.header("x-run-token") || "";
      if (token !== config.runToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    try {
      const mode = String(req.query.mode ?? req.body?.mode ?? "scan");
      if (mode === "monitor") {
        const result = await runMonitor({ remediate: false });
        res.json({ ok: true, mode: "monitor", result });
        return;
      }
      if (mode === "remediate") {
        const result = await runRemediation();
        res.json({ ok: true, mode: "remediate", result });
        return;
      }
      if (mode === "both" || mode === "all") {
        const scan = await runScan("manual");
        const monitorBundle = await runMonitor({ remediate: true });
        res.json({
          ok: true,
          mode,
          scan,
          monitor: (monitorBundle as { monitor?: unknown })?.monitor ?? monitorBundle,
          remediation: (monitorBundle as { remediation?: unknown })?.remediation ?? null,
        });
        return;
      }
      const result = await runScan("manual");
      res.json({ ok: true, mode: "scan", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[run] Failed", error);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.listen(config.port, config.host, () => {
    console.log(
      `[boot] Deliverability Wizard listening on ${config.host}:${config.port}`,
    );
    console.log(`[boot] Scan cron: ${config.cronScan}`);
    console.log(`[boot] Monitor cron: ${config.cronMonitor}`);
    console.log(
      `[boot] Remediation: ${config.enableRemediation ? "ENABLED" : "disabled"} (threshold ${config.remediationInboxThreshold}%)`,
    );
    console.log(`[boot] InboxKit: ${inboxkit ? "configured" : "not configured"}`);
    console.log(`[boot] State file: ${config.stateFilePath}`);
  });
}

main().catch((error) => {
  console.error("[boot] Fatal", error);
  process.exit(1);
});
