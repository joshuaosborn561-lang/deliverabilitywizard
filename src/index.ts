import express from "express";
import cron from "node-cron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRuntimeSecrets, configIsReady, loadConfig } from "./config.js";
import { SmartleadClient } from "./clients/smartlead.js";
import { SmartDeliveryClient } from "./clients/smartdelivery.js";
import { InboxKitClient } from "./clients/inboxkit.js";
import { SlackClient } from "./clients/slack.js";
import { StateStore, type PoolProvisionPhase } from "./state/store.js";
import { SpendGateway } from "./lib/spendGateway.js";
import { CampaignScanner } from "./services/campaignScanner.js";
import { ResultMonitor } from "./services/resultMonitor.js";
import { RemediationService } from "./services/remediation.js";
import { DnsAuditService } from "./services/dnsAudit.js";
import { CampaignAuditService } from "./services/campaignAudit.js";
import { CampaignTopUpService } from "./services/campaignTopUp.js";
import { MailboxSettingsService } from "./services/mailboxSettings.js";
import { PoolProvisioner } from "./services/poolProvisioner.js";
import { AccountReconnectService } from "./services/accountReconnect.js";
import { WarmupGateService } from "./services/warmupGate.js";
import { TestReconciler } from "./services/testReconciler.js";
import {
  FleetSummaryService,
  PlacementResultsService,
} from "./services/opsReporting.js";
import { OpsAuth } from "./ops/auth.js";
import { createOpsRouter } from "./ops/router.js";
import {
  ManualRotationService,
  type RotationResult,
} from "./ops/manualRotation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    ? new InboxKitClient(
        config.inboxkitApiKey,
        config.inboxkitWorkspaceId ||
          config.genericPoolWorkspaceId ||
          undefined,
        config.genericPoolWorkspaceId || undefined,
      )
    : null;
  const slack = new SlackClient({
    webhookUrl: config.slackWebhookUrl,
    botToken: config.slackBotToken,
    channelId: config.slackChannelId,
    channelLabel: config.slackChannel,
  });
  const scanner = new CampaignScanner(config, smartlead, smartDelivery, slack, state);
  const monitor = new ResultMonitor(config, smartDelivery, slack, state);
  const spendGateway = new SpendGateway(state, slack, config.requireSpendApproval);
  const remediation = new RemediationService(
    config,
    smartlead,
    smartDelivery,
    inboxkit,
    slack,
    state,
    spendGateway,
  );
  const poolProvisioner = new PoolProvisioner(
    config,
    inboxkit,
    smartlead,
    slack,
    state,
    spendGateway,
  );
  const accountReconnect = new AccountReconnectService(
    config,
    smartlead,
    inboxkit,
    slack,
    state,
  );
  const warmupGate = new WarmupGateService(config, smartlead, slack, state);
  const testReconciler = new TestReconciler(
    config,
    smartlead,
    smartDelivery,
    slack,
    state,
  );

  let scanInFlight: Promise<unknown> | null = null;
  let monitorInFlight: Promise<unknown> | null = null;
  let remediationInFlight: Promise<unknown> | null = null;
  let poolInFlight: Promise<unknown> | null = null;
  let reconnectInFlight: Promise<unknown> | null = null;
  let warmupGateInFlight: Promise<unknown> | null = null;
  let reconcileInFlight: Promise<unknown> | null = null;
  let topUpInFlight: Promise<unknown> | null = null;
  let manualRotationInFlight: Promise<RotationResult> | null = null;
  let opsCheckInFlight: Promise<{
    monitor: unknown;
    dns: unknown;
    campaigns: unknown;
  }> | null = null;

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
    if (manualRotationInFlight) {
      console.log(
        "[remediation] Manual rotation active — skipping overlapping trigger",
      );
      return { skipped: true as const, reason: "manual-rotation-active" };
    }
    if (remediationInFlight) {
      console.log("[remediation] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    remediationInFlight = remediation.run().finally(() => {
      remediationInFlight = null;
    });
    return remediationInFlight;
  };

  const runPoolProvision = async () => {
    if (manualRotationInFlight) {
      console.log(
        "[pool-provision] Manual rotation active — skipping overlapping trigger",
      );
      return { skipped: true as const, reason: "manual-rotation-active" };
    }
    if (poolInFlight) {
      console.log("[pool-provision] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    poolInFlight = poolProvisioner.run().finally(() => {
      poolInFlight = null;
    });
    return poolInFlight;
  };

  const runReconnect = async () => {
    assertRuntimeSecrets(config);
    if (reconnectInFlight) {
      console.log("[reconnect] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    reconnectInFlight = accountReconnect.run().finally(() => {
      reconnectInFlight = null;
    });
    return reconnectInFlight;
  };

  const runWarmupGate = async () => {
    assertRuntimeSecrets(config);
    if (warmupGateInFlight) {
      console.log("[warmup-gate] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    warmupGateInFlight = warmupGate.run().finally(() => {
      warmupGateInFlight = null;
    });
    return warmupGateInFlight;
  };

  const runTestReconcile = async () => {
    assertRuntimeSecrets(config);
    if (reconcileInFlight) {
      console.log("[test-reconciler] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    reconcileInFlight = testReconciler.run().finally(() => {
      reconcileInFlight = null;
    });
    return reconcileInFlight;
  };

  const dnsAudit = new DnsAuditService(smartlead, slack, state);
  const mailboxSettings = new MailboxSettingsService(config, smartlead, slack);
  const campaignTopUp = new CampaignTopUpService(
    config,
    smartlead,
    slack,
    state,
  );
  const campaignAudit = new CampaignAuditService(
    config,
    smartlead,
    smartDelivery,
    state,
  );
  const manualRotation = new ManualRotationService(
    config,
    smartlead,
    slack,
    state,
  );
  const opsAuth = new OpsAuth({
    enabled: config.opsUiEnabled,
    ownerUsername: config.opsOwnerUsername,
    operatorUsername: config.opsOperatorUsername,
    ownerToken: config.opsOwnerToken,
    operatorToken: config.opsOperatorToken,
    sessionSecret: config.opsSessionSecret,
    sessionHours: config.opsSessionHours,
  });
  if (config.opsUiEnabled && !opsAuth.isConfigured()) {
    throw new Error(
      `OPS_UI_ENABLED=true but the console is not securely configured: ${opsAuth.configurationError()}`,
    );
  }
  const placementResults = new PlacementResultsService(
    smartDelivery,
    state,
  );
  const fleetSummary = new FleetSummaryService(smartlead, state);

  const runCampaignTopUp = async () => {
    if (manualRotationInFlight) {
      console.log("[top-up] Manual rotation active — skipping overlapping run");
      return { skipped: true as const, reason: "manual-rotation-active" };
    }
    if (topUpInFlight) {
      console.log("[top-up] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    topUpInFlight = campaignTopUp.run().finally(() => {
      topUpInFlight = null;
    });
    return topUpInFlight;
  };

  const runManualRotation = async (email: string) => {
    if (
      manualRotationInFlight ||
      topUpInFlight ||
      poolInFlight ||
      remediationInFlight ||
      monitorInFlight
    ) {
      throw new Error(
        "A campaign mutation is already running. Wait and preview the rotation again.",
      );
    }
    manualRotationInFlight = manualRotation.execute(email).finally(() => {
      manualRotationInFlight = null;
    });
    return manualRotationInFlight;
  };

  const runOpsDeliverability = async () => {
    if (opsCheckInFlight || monitorInFlight) {
      throw new Error("A deliverability monitor is already running.");
    }
    opsCheckInFlight = (async () => {
      const monitorResult = await monitor.run();
      const dnsResult = await dnsAudit.run({ alert: false });
      const campaignResult = await campaignAudit.run(
        config.minCampaignSenders,
      );
      return {
        monitor: monitorResult,
        dns: dnsResult,
        campaigns: campaignResult,
      };
    })().finally(() => {
      opsCheckInFlight = null;
    });
    return opsCheckInFlight;
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
      let warmupGateResult: unknown = null;
      if (config.enableWarmupGate) {
        warmupGateResult = await runWarmupGate();
      }
      // Stop recurring tests whose campaign stopped being active since the scan
      let reconcileResult: unknown = null;
      if (config.enableTestReconciler) {
        reconcileResult = await runTestReconcile();
      }
      // Stay on top of disconnects between the daily 3am ET pass
      let reconnectResult: unknown = null;
      if (config.enableAccountReconnect) {
        reconnectResult = await runReconnect();
      }
      // Zone-level faults are invisible from inside Smartlead; resolve DNS
      // directly so a domain sending without SPF cannot stay silent.
      let dnsAuditResult: unknown = null;
      try {
        dnsAuditResult = await dnsAudit.run();
      } catch (error) {
        console.warn("[dns-audit] failed", error);
      }
      // Refill thin campaigns from the generic pool. Runs after remediation
      // so a sender benched this pass is replaced in the same cycle.
      // Converge every mailbox on the agreed send cap and warmup state first,
      // so senders placed by the top-up below already carry it.
      let mailboxSettingsResult: unknown = null;
      try {
        mailboxSettingsResult = await mailboxSettings.run();
      } catch (error) {
        console.warn("[mailbox-settings] failed", error);
      }
      let topUpResult: unknown = null;
      try {
        topUpResult = await runCampaignTopUp();
      } catch (error) {
        console.warn("[top-up] failed", error);
      }
      // Campaign-level health: a campaign can bleed senders to recovery holds
      // or never pick up a placement test, and neither shows in the
      // mailbox-oriented remediation summary.
      let campaignAuditResult: unknown = null;
      try {
        campaignAuditResult = await campaignAudit.run(config.minCampaignSenders);
      } catch (error) {
        console.warn("[campaign-audit] failed", error);
      }
      return {
        monitor: monitorResult,
        remediation: remediationResult,
        warmupGate: warmupGateResult,
        testReconcile: reconcileResult,
        reconnect: reconnectResult,
        dnsAudit: dnsAuditResult,
        campaignAudit: campaignAuditResult,
        topUp: topUpResult,
        mailboxSettings: mailboxSettingsResult,
      };
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
  if (!cron.validate(config.cronPoolProvision)) {
    throw new Error(
      `Invalid CRON_POOL_PROVISION expression: ${config.cronPoolProvision}`,
    );
  }
  if (!cron.validate(config.cronAccountReconnect)) {
    throw new Error(
      `Invalid CRON_ACCOUNT_RECONNECT expression: ${config.cronAccountReconnect}`,
    );
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

  if (config.enablePoolProvisioner) {
    cron.schedule(config.cronPoolProvision, () => {
      void runPoolProvision().catch((error) => {
        console.error("[pool-provision] Unhandled cron error", error);
      });
    });
    // Kick once shortly after boot so we don't wait up to 30m
    setTimeout(() => {
      void runPoolProvision().catch((error) => {
        console.error("[pool-provision] Boot kick failed", error);
      });
    }, 15_000);
  }

  if (config.enableAccountReconnect) {
    // Daily full pass at 3am America/New_York (EST/EDT)
    cron.schedule(
      config.cronAccountReconnect,
      () => {
        void runReconnect().catch((error) => {
          console.error("[reconnect] Unhandled cron error", error);
        });
      },
      { timezone: "America/New_York" },
    );
    // Also kick shortly after boot so disconnects don't wait until 3am
    setTimeout(() => {
      void runReconnect().catch((error) => {
        console.error("[reconnect] Boot kick failed", error);
      });
    }, 20_000);
  }

  const app = express();
  // Railway terminates TLS one proxy hop in front of the app. This makes
  // req.ip useful for login throttling without trusting arbitrary forwarded
  // chains.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "100kb" }));

  app.use("/ops", (_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(
    "/ops/api",
    createOpsRouter({
      config,
      auth: opsAuth,
      state,
      rotation: manualRotation,
      executeRotation: runManualRotation,
      runtime: {
        deliverability: runOpsDeliverability,
        dns: () => dnsAudit.run({ alert: false }),
        campaigns: () => campaignAudit.run(config.minCampaignSenders),
        reconnect: runReconnect,
        placements: (force) => placementResults.get(force),
        fleet: (force) => fleetSummary.get(force),
      },
    }),
  );
  const opsPublicDir = path.resolve(__dirname, "../public/ops");
  app.use(
    "/ops",
    express.static(opsPublicDir, {
      index: "index.html",
      etag: true,
      maxAge: 0,
    }),
  );

  // Operational state contains mailbox addresses, client assignments and
  // spend decisions. Sensitive/read-write routes are disabled entirely when
  // RUN_TOKEN is missing rather than silently becoming public.
  const checkRunToken = (
    req: express.Request,
    res: express.Response,
  ): boolean => {
    if (!config.runToken) {
      res.status(503).json({
        error: "Protected route disabled: RUN_TOKEN is not configured",
      });
      return false;
    }
    const token = req.header("x-run-token") || "";
    if (token !== config.runToken) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  };

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
      lastReconnectAt: s.lastReconnectAt,
      lastWarmupGateAt: s.lastWarmupGateAt,
      testedCampaignCount: Object.keys(s.testedCampaigns).length,
      cronScan: config.cronScan,
      cronMonitor: config.cronMonitor,
      totalTestQuota: config.totalTestQuota,
      maxMailboxesPerTest: config.maxMailboxesPerTest,
      autoPlacementTests: config.autoPlacementTests,
      placementTestEveryDays: config.placementTestEveryDays,
      autoTestActiveStatuses: config.autoTestActiveStatuses,
      enableTestReconciler: config.enableTestReconciler,
      remediationInboxThreshold: config.remediationInboxThreshold,
      scoreSameEspOnly: config.scoreSameEspOnly,
      minSameEspSamples: config.minSameEspSamples,
      enableRecoveryPool: config.enableRecoveryPool,
      poolWarmupDays: config.poolWarmupDays,
      enableWarmupGate: config.enableWarmupGate,
      campaignMinWarmupDays: config.campaignMinWarmupDays,
      enablePoolProvisioner: config.enablePoolProvisioner,
      poolProvisionPhase: s.poolProvision?.phase ?? "idle",
      poolMailboxCount: Object.keys(s.poolMailboxes).length,
      activeSwapCount: Object.keys(s.activeSwaps).length,
      requireSpendApproval: config.requireSpendApproval,
      pendingSpendApprovals: Object.values(s.spendApprovals).filter(
        (a) => a.status === "pending",
      ).length,
      cronPoolProvision: config.cronPoolProvision,
      enableAccountReconnect: config.enableAccountReconnect,
      cronAccountReconnect: config.cronAccountReconnect,
      cronAccountReconnectTz: "America/New_York",
      opsUiEnabled: config.opsUiEnabled,
      opsUiConfigured: opsAuth.isConfigured(),
    });
  });

  app.get("/status", (req, res) => {
    if (!checkRunToken(req, res)) return;
    res.json({
      state: state.get(),
      config: {
        campaignStatuses: config.campaignStatuses,
        cronScan: config.cronScan,
        cronMonitor: config.cronMonitor,
        cronPoolProvision: config.cronPoolProvision,
        cronAccountReconnect: config.cronAccountReconnect,
        totalTestQuota: config.totalTestQuota,
        maxMailboxesPerTest: config.maxMailboxesPerTest,
        autoPlacementTests: config.autoPlacementTests,
        placementTestEveryDays: config.placementTestEveryDays,
        placementTestEndDays: config.placementTestEndDays,
        autoTestActiveStatuses: config.autoTestActiveStatuses,
        enableTestReconciler: config.enableTestReconciler,
        deliverabilityThreshold: config.deliverabilityThreshold,
        remediationInboxThreshold: config.remediationInboxThreshold,
        scoreSameEspOnly: config.scoreSameEspOnly,
        minSameEspSamples: config.minSameEspSamples,
        enableRemediation: config.enableRemediation,
        enableRecoveryPool: config.enableRecoveryPool,
        enablePoolProvisioner: config.enablePoolProvisioner,
        enableAccountReconnect: config.enableAccountReconnect,
        enableWarmupGate: config.enableWarmupGate,
        campaignMinWarmupDays: config.campaignMinWarmupDays,
        poolWarmupDays: config.poolWarmupDays,
        clientDomainBudgetUsd: config.clientDomainBudgetUsd,
        clientMailboxMonthlyCap: config.clientMailboxMonthlyCap,
        inboxkitConfigured: Boolean(config.inboxkitApiKey),
        sequenceNumber: config.sequenceNumber,
        dryRun: config.dryRun,
        requireSpendApproval: config.requireSpendApproval,
        minCampaignSenders: config.minCampaignSenders,
        messagePerDay: config.messagePerDay,
        enableCampaignTopUp: config.enableCampaignTopUp,
        enforceMailboxSettings: config.enforceMailboxSettings,
        enableBounceRotation: config.enableBounceRotation,
        bounceRateThreshold: config.bounceRateThreshold,
        minBounceSample: config.minBounceSample,
        opsUiEnabled: config.opsUiEnabled,
        opsUiConfigured: opsAuth.isConfigured(),
      },
    });
  });

  // Legacy token-authenticated approval listing for scripts/diagnostics.
  // Decisions are intentionally owner-session + CSRF only under /ops.
  app.get("/approvals", (req, res) => {
    if (!checkRunToken(req, res)) return;
    res.json({ approvals: state.listSpendApprovals() });
  });

  app.post("/run", async (req, res) => {
    if (!checkRunToken(req, res)) return;

    try {
      const mode = String(req.query.mode ?? req.body?.mode ?? "scan");
      if (mode === "monitor") {
        const result = await runMonitor({ remediate: false });
        res.json({ ok: true, mode: "monitor", result });
        return;
      }
      if (mode === "remediate") {
        const reset =
          String(req.query.reset ?? req.body?.reset ?? "") === "1" ||
          String(req.query.reset ?? req.body?.reset ?? "").toLowerCase() ===
            "true";
        if (reset) {
          const cleared = state.clearInboxRemediations();
          await state.save();
          console.log(
            `[remediation] Cleared ${cleared} inbox remediation dedupe keys before retry`,
          );
        }
        const result = await runRemediation();
        res.json({
          ok: true,
          mode: "remediate",
          resetInboxDedupe: reset,
          result,
        });
        return;
      }
      if (mode === "pool" || mode === "pool-provision") {
        // Optional phase reset — needed to restart a pipeline stuck in a
        // terminal-ish phase. This never spends: any purchase the restarted
        // pipeline wants still has to clear the spend approval gateway.
        const phase = String(req.query.phase ?? req.body?.phase ?? "").trim();
        if (phase) {
          const allowed: PoolProvisionPhase[] = [
            "idle",
            "awaiting_ns",
            "buying",
            "awaiting_mailboxes",
            "awaiting_sequencer",
            "exporting",
            "awaiting_export",
            "importing_state",
            "warming",
            "ready",
          ];
          if (!allowed.includes(phase as PoolProvisionPhase)) {
            res.status(400).json({
              ok: false,
              error: `Invalid phase '${phase}'. Allowed: ${allowed.join(", ")}`,
            });
            return;
          }
          state.setPoolProvision({
            phase: phase as PoolProvisionPhase,
            lastError: undefined,
            lastMessage: `Phase manually reset to ${phase}`,
          });
          await state.save();
          console.log(`[pool-provision] Phase manually reset to ${phase}`);
        }
        const result = await runPoolProvision();
        res.json({
          ok: true,
          mode: "pool",
          ...(phase ? { phaseResetTo: phase } : {}),
          result,
        });
        return;
      }
      if (mode === "reconnect") {
        const result = await runReconnect();
        res.json({ ok: true, mode: "reconnect", result });
        return;
      }
      if (mode === "warmup-gate" || mode === "warmup") {
        const result = await runWarmupGate();
        res.json({ ok: true, mode: "warmup-gate", result });
        return;
      }
      if (mode === "reconcile" || mode === "test-reconcile") {
        const result = await runTestReconcile();
        res.json({ ok: true, mode: "reconcile", result });
        return;
      }
      if (mode === "both" || mode === "all") {
        const scan = await runScan("manual");
        const monitorBundle = await runMonitor({ remediate: true });
        const pool = config.enablePoolProvisioner
          ? await runPoolProvision()
          : null;
        const reconnect = config.enableAccountReconnect
          ? await runReconnect()
          : null;
        res.json({
          ok: true,
          mode,
          scan,
          monitor: (monitorBundle as { monitor?: unknown })?.monitor ?? monitorBundle,
          remediation: (monitorBundle as { remediation?: unknown })?.remediation ?? null,
          warmupGate: (monitorBundle as { warmupGate?: unknown })?.warmupGate ?? null,
          pool,
          reconnect,
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
    // Campaign headcount and test cover, at boot as well as on the monitor —
    // waiting up to six hours to learn a campaign is sending with no test is
    // too long when the shortfall is being worked on right now.
    if (secretsReady) {
      void (async () => {
        try {
          await manualRotation.recoverStaleReservations();
          await campaignAudit.run(config.minCampaignSenders);
          await mailboxSettings.run();
          // Fill thin campaigns at boot as well as on the monitor. A restart
          // is the only lever that acts sooner than the six-hourly cron, and
          // a campaign sending under its floor should not wait that long.
          // Idempotent: once every campaign is at the floor this is a no-op.
          await runCampaignTopUp();
        } catch (error) {
          console.warn("[boot] campaign audit/top-up failed", error);
        }
      })();
    }
    console.log(
      `[boot] Placement tests: ${config.autoPlacementTests ? `RECURRING every ${config.placementTestEveryDays}d while campaign in [${config.autoTestActiveStatuses.join(",")}]` : "one-off manual"}${config.enableTestReconciler ? " (auto-stop on inactive)" : ""}`,
    );
    console.log(`[boot] Monitor cron: ${config.cronMonitor}`);
    console.log(
      `[boot] Mailbox settings: ${config.enforceMailboxSettings ? `ENFORCED (${config.messagePerDay} sends/day, warmup on)` : "not enforced"}`,
    );
    console.log(
      `[boot] Campaign top-up: ${config.enableCampaignTopUp ? `ENABLED (floor ${config.minCampaignSenders} senders${config.topUpExcludeCampaigns.length ? `, excluding ${config.topUpExcludeCampaigns.join(", ")}` : ""})` : "disabled"}`,
    );
    console.log(
      `[boot] Remediation: ${config.enableRemediation ? "ENABLED" : "disabled"} (threshold ${config.remediationInboxThreshold}%)`,
    );
    console.log(
      `[boot] Pool provisioner: ${config.enablePoolProvisioner ? `ENABLED (${config.cronPoolProvision})` : "disabled"} phase=${state.get().poolProvision.phase}`,
    );
    console.log(
      `[boot] Account reconnect: ${config.enableAccountReconnect ? `ENABLED (${config.cronAccountReconnect} America/New_York)` : "disabled"}`,
    );
    console.log(
      `[boot] Warmup gate: ${config.enableWarmupGate ? `ENABLED (min ${config.campaignMinWarmupDays}d + HOLD strip, runs with monitor)` : "disabled"}`,
    );
    console.log(`[boot] InboxKit: ${inboxkit ? "configured" : "not configured"}`);
    console.log(
      `[boot] Ops UI: ${config.opsUiEnabled ? (opsAuth.isConfigured() ? "ENABLED at /ops" : `disabled until configured (${opsAuth.configurationError()})`) : "disabled"}`,
    );
    console.log(
      `[boot] Spend approval gateway: ${config.requireSpendApproval ? "ENABLED (real-money spend held for human approval via /approvals)" : "DISABLED — spend executes unattended"}`,
    );
    console.log(`[boot] State file: ${config.stateFilePath}`);
  });
}

main().catch((error) => {
  console.error("[boot] Fatal", error);
  process.exit(1);
});
