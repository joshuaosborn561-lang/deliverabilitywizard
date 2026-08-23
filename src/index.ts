import express from "express";
import cron from "node-cron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRuntimeSecrets, configIsReady, loadConfig } from "./config.js";
import { SmartleadClient } from "./clients/smartlead.js";
import {
  SmartDeliveryClient,
  campaignIdOf,
  isAutomatedTest,
  isTestStoppable,
  normalizeTestList,
  testIdOf,
} from "./clients/smartdelivery.js";
import { InboxKitClient } from "./clients/inboxkit.js";
import { PorkbunClient } from "./clients/porkbun.js";
import { SlackClient } from "./clients/slack.js";
import { slackRoleOf } from "./lib/isolationActors.js";
import {
  parseIsolationActionValue,
  slackSignatureValid,
} from "./lib/slackSignature.js";
import {
  exchangeSlackOauth,
  writeSlackBotTokenFile,
} from "./lib/slackOauth.js";
import { StateStore, type PoolProvisionPhase } from "./state/store.js";
import { SpendGateway } from "./lib/spendGateway.js";
import { CampaignScanner } from "./services/campaignScanner.js";
import { ResultMonitor } from "./services/resultMonitor.js";
import { RemediationService } from "./services/remediation.js";
import { DnsAuditService } from "./services/dnsAudit.js";
import { CampaignAuditService } from "./services/campaignAudit.js";
import { CampaignTopUpService } from "./services/campaignTopUp.js";
import { CampaignHealthService } from "./services/campaignHealth.js";
import { ClientFanOutService } from "./services/clientFanOut.js";
import { CampaignBounceInvestigateService } from "./services/campaignBounceInvestigate.js";
import { parseSchedules } from "./services/sendVolume.js";
import { ClientDayBriefService } from "./services/clientDayBrief.js";
import { HeldPlacementTestService } from "./services/heldPlacementTests.js";
import { ClientRestService } from "./services/clientRest.js";
import { GenericSendRestService } from "./services/genericSendRest.js";
import { RestBaselineRebuildService } from "./services/restBaselineRebuild.js";
import { MailboxSettingsService } from "./services/mailboxSettings.js";
import { PoolProvisioner } from "./services/poolProvisioner.js";
import { AccountReconnectService } from "./services/accountReconnect.js";
import { WarmupGateService } from "./services/warmupGate.js";
import { TestReconciler } from "./services/testReconciler.js";
import { PlacementAuditService } from "./services/placementAudit.js";
import { BcpClientRestoreService } from "./services/bcpClientRestore.js";
import {
  FleetSummaryService,
  PlacementResultsService,
} from "./services/opsReporting.js";
import { CursorCloudClient } from "./clients/cursorCloud.js";
import { OpsAuth } from "./ops/auth.js";
import { CursorAssistantService } from "./ops/cursorAssistant.js";
import { createOpsRouter } from "./ops/router.js";
import {
  ManualRotationService,
  type RotationResult,
} from "./ops/manualRotation.js";
import { BugRemediator } from "./services/bugRemediator.js";
import { MutationQueue } from "./lib/mutationQueue.js";
import { PodControlService } from "./services/podControls.js";
import { IsolationRigService } from "./services/isolationRig.js";
import { CopyIsolationService } from "./services/copyIsolation.js";
import { IsolationBranchService } from "./services/isolationBranch.js";
import { DeliveryWatchService } from "./services/deliveryWatch.js";
import { IsolationBuyService } from "./services/isolationBuy.js";
import { IsolationExecuteService } from "./services/isolationExecute.js";
import { DomainLifecycleService } from "./services/domainLifecycle.js";
import { CopyCanaryService } from "./services/copyCanary.js";

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
  // Serialise Smartlead writes across health / remediation / settings so
  // overlapping crons do not stampede into 429s (D25).
  smartlead.setMutationQueue(new MutationQueue(250));
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
    botTokenFile: config.slackBotTokenFile,
    channelId: config.slackChannelId,
    channelLabel: config.slackChannel,
  });
  const scanner = new CampaignScanner(config, smartlead, smartDelivery, slack, state);
  const monitor = new ResultMonitor(config, smartDelivery, smartlead, slack, state);
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
  const placementAudit = new PlacementAuditService(
    config,
    smartlead,
    smartDelivery,
    slack,
    state,
  );
  const bcpClientRestore = new BcpClientRestoreService(
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
  let healthInFlight: Promise<unknown> | null = null;
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
    scanInFlight = (async () => {
      const result = await scanner.run({ trigger });
      feedBugRemediator(
        "scan",
        (result as { errors?: string[] })?.errors ?? [],
      );
      return result;
    })().finally(() => {
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
    remediationInFlight = (async () => {
      const result = await remediation.run();
      // Also fed by runMonitor for the cron path; without it here a direct
      // /run?mode=remediate discarded its errors entirely.
      feedBugRemediator(
        "remediation",
        (result as { errors?: string[] })?.errors ?? [],
      );
      return result;
    })().finally(() => {
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
  const clientFanOut = new ClientFanOutService(
    config,
    smartlead,
    slack,
    state,
  );
  const clientRest = new ClientRestService(config, smartlead, slack, state);
  const genericSendRest = new GenericSendRestService(
    config,
    smartlead,
    slack,
    state,
  );
  const restBaselineRebuild = new RestBaselineRebuildService(
    config,
    smartlead,
    slack,
    state,
  );
  const copyCanary = new CopyCanaryService(
    config,
    smartlead,
    smartDelivery,
    slack,
    state,
  );
  const campaignHealth = new CampaignHealthService(
    config,
    smartlead,
    slack,
    state,
    campaignTopUp,
    clientFanOut,
    copyCanary,
  );
  const heldPlacementTests = new HeldPlacementTestService(
    config,
    smartlead,
    smartDelivery,
    slack,
    state,
  );
  const bounceInvestigate = new CampaignBounceInvestigateService(
    config,
    smartlead,
    smartDelivery,
    slack,
    state,
  );
  const isolationRig = new IsolationRigService(
    config,
    smartlead,
    smartDelivery,
    slack,
    state,
  );
  const copyIsolation = new CopyIsolationService(
    config,
    smartlead,
    smartDelivery,
    slack,
    state,
    isolationRig,
  );
  const isolationBranch = new IsolationBranchService(
    config,
    smartlead,
    smartDelivery,
    slack,
    state,
    copyIsolation,
    isolationRig,
    copyCanary,
  );
  const podControls = new PodControlService(
    config,
    smartlead,
    smartDelivery,
    slack,
    state,
  );
  const porkbun =
    config.porkbunApiKey && config.porkbunSecretApiKey
      ? new PorkbunClient({
          apiKey: config.porkbunApiKey,
          secretApiKey: config.porkbunSecretApiKey,
        })
      : null;
  const isolationBuy = new IsolationBuyService(
    config,
    inboxkit,
    porkbun,
    state,
    spendGateway,
  );
  const isolationExecute = new IsolationExecuteService(
    config,
    smartlead,
    slack,
    state,
    isolationBuy,
  );
  const domainLifecycle = new DomainLifecycleService(config, state, slack);
  const deliveryWatch = new DeliveryWatchService(
    config,
    smartlead,
    slack,
    state,
    isolationBranch,
  );
  void isolationRig.applyDenylist().catch((error) => {
    console.warn("[isolation-rig] denylist at boot failed", error);
  });
  const campaignAudit = new CampaignAuditService(
    config,
    smartlead,
    smartDelivery,
    state,
  );
  const clientDayBrief = new ClientDayBriefService(
    config,
    smartlead,
    smartDelivery,
    slack,
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
  const cursorCloud = config.cursorApiKey
    ? new CursorCloudClient(config.cursorApiKey)
    : null;
  const cursorAssistant = cursorCloud
    ? new CursorAssistantService(cursorCloud, state, {
        repositoryUrl: config.cursorAgentRepositoryUrl,
        startingRef: config.cursorAgentStartingRef,
        model: {
          id: config.cursorAgentModelId,
          params: config.cursorAgentModelParams,
        },
        timeoutMs: config.cursorAgentTimeoutMs,
      })
    : null;
  const bugRemediator = new BugRemediator(
    config,
    cursorCloud,
    slack,
    state,
  );

  const feedBugRemediator = (
    source: string,
    errors: unknown,
  ): void => {
    const list = Array.isArray(errors)
      ? errors.map((e) => (typeof e === "string" ? e : String(e)))
      : errors
        ? [errors instanceof Error ? errors.message : String(errors)]
        : [];
    if (!list.length || !bugRemediator.enabled()) return;
    void bugRemediator.observeMany(source, list).catch((error) => {
      console.warn("[bug-remediator] observe failed", error);
    });
  };

  const runRestGates = async () => {
    let restBaseline: unknown = null;
    let restResult: unknown = null;
    let genericRest: unknown = null;
    if (config.enableRestBaselineRebuild) {
      try {
        restBaseline = await restBaselineRebuild.run();
      } catch (error) {
        console.warn("[health] rest baseline rebuild failed", error);
      }
    }
    if (config.enableClientRest) {
      try {
        restResult = await clientRest.run();
      } catch (error) {
        console.warn("[health] client rest failed", error);
      }
    }
    if (config.enableGenericSendRest) {
      try {
        genericRest = await genericSendRest.run();
      } catch (error) {
        console.warn("[health] generic send rest failed", error);
      }
    }
    return { restBaseline, clientRest: restResult, genericRest };
  };

  const runCampaignTopUp = async () => {
    if (manualRotationInFlight) {
      console.log("[top-up] Manual rotation active — skipping overlapping run");
      return { skipped: true as const, reason: "manual-rotation-active" };
    }
    if (topUpInFlight || healthInFlight) {
      console.log("[top-up] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    topUpInFlight = (async () => {
      const rest = await runRestGates();
      const result = await campaignTopUp.run();
      return { ...rest, topUp: result };
    })().finally(() => {
      topUpInFlight = null;
    });
    return topUpInFlight;
  };

  /** How often the health cron may run a full mailbox-settings converge. */
  const MAILBOX_SETTINGS_EVERY_MS = 6 * 60 * 60 * 1000;

  /**
   * Fast staffing loop (D43/D44): hold rebuild → client rest → generic
   * send clock → top-up/fan-out → reconnect. Mailbox-settings converge is
   * throttled (every 6h). Measure stays on CRON_MONITOR.
   */
  const runHealth = async () => {
    assertRuntimeSecrets(config);
    if (manualRotationInFlight) {
      console.log("[health] Manual rotation active — skipping");
      return { skipped: true as const, reason: "manual-rotation-active" };
    }
    if (healthInFlight) {
      console.log("[health] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    healthInFlight = (async () => {
      const rest = await runRestGates();

      let healthResult: unknown = null;
      try {
        healthResult = await campaignHealth.run();
      } catch (error) {
        console.warn("[health] campaign health failed", error);
        throw error;
      }

      let reconnectResult: unknown = null;
      if (config.enableAccountReconnect) {
        try {
          reconnectResult = await runReconnect();
        } catch (error) {
          console.warn("[health] reconnect failed", error);
        }
      }

      // D30/D35: gap + daily volume every health pass. Full signature/warmup
      // converge stays throttled so it cannot starve the 15-minute staffing loop.
      let mailboxGapResult: unknown = null;
      let mailboxSettingsResult: unknown = null;
      if (config.enforceMailboxSettings) {
        try {
          mailboxGapResult = await mailboxSettings.runGapEnforce();
        } catch (error) {
          console.warn("[health] mailbox gap enforce failed", error);
        }

        const lastSettingsAt = state.get().lastMailboxSettingsAt;
        const settingsAgeMs = lastSettingsAt
          ? Date.now() - Date.parse(lastSettingsAt)
          : Number.POSITIVE_INFINITY;
        if (settingsAgeMs >= MAILBOX_SETTINGS_EVERY_MS) {
          try {
            mailboxSettingsResult = await mailboxSettings.run({ mode: "full" });
            state.setLastMailboxSettingsAt(new Date().toISOString());
            await state.save();
          } catch (error) {
            console.warn("[health] mailbox-settings failed", error);
          }
        } else {
          console.log(
            `[health] Skipping full mailbox-settings (last ${lastSettingsAt ?? "never"}; due every 6h; gap enforce already ran)`,
          );
        }
      }

      return {
        restBaseline: rest.restBaseline,
        clientRest: rest.clientRest,
        genericRest: rest.genericRest,
        health: healthResult,
        reconnect: reconnectResult,
        mailboxGap: mailboxGapResult,
        mailboxSettings: mailboxSettingsResult,
      };
    })().finally(() => {
      healthInFlight = null;
    });
    return healthInFlight;
  };

  const runManualRotation = async (email: string) => {
    if (
      manualRotationInFlight ||
      topUpInFlight ||
      healthInFlight ||
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
      feedBugRemediator(
        "monitor",
        (monitorResult as { errors?: string[] })?.errors ?? [],
      );
      const shouldRemediate =
        opts.remediate !== false &&
        (config.enableRemediation || config.dryRun);
      let remediationResult: unknown = null;
      if (shouldRemediate) {
        remediationResult = await runRemediation();
        feedBugRemediator(
          "remediation",
          (remediationResult as { errors?: string[] })?.errors ?? [],
        );
      }
      // D39: held/pulled mailboxes get their own SmartDelivery tests — they
      // stay off live campaigns; the test only uses a campaign as sequence shell.
      let heldTestsResult: unknown = null;
      if (config.enableHeldPlacementTests) {
        try {
          heldTestsResult = await heldPlacementTests.run();
        } catch (error) {
          console.warn("[held-tests] failed", error);
        }
      }
      let restTestsResult: unknown = null;
      if (config.enableRestPlacementTests) {
        try {
          restTestsResult = await heldPlacementTests.runResting();
        } catch (error) {
          console.warn("[rest-tests] failed", error);
        }
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
      // Zone-level faults are invisible from inside Smartlead; resolve DNS
      // directly so a domain sending without SPF cannot stay silent.
      let dnsAuditResult: unknown = null;
      try {
        dnsAuditResult = await dnsAudit.run();
      } catch (error) {
        console.warn("[dns-audit] failed", error);
      }
      // Campaign-level audit (read-only). Staffing mutations live on the
      // faster CRON_HEALTH loop so thin campaigns do not wait six hours.
      let campaignAuditResult: unknown = null;
      try {
        campaignAuditResult = await campaignAudit.run(config.minCampaignSenders);
      } catch (error) {
        console.warn("[campaign-audit] failed", error);
      }
      // D29: PAUSED campaigns with high aggregate sender bounce → investigate
      // (skip sender rotation when placement says the copy is the cause).
      let bounceInvestigateResult: unknown = null;
      try {
        bounceInvestigateResult = await bounceInvestigate.run();
      } catch (error) {
        console.warn("[bounce-investigate] failed", error);
      }
      let podControlResult: unknown = null;
      if (config.enablePodControls) {
        try {
          podControlResult = await podControls.run();
          try {
            await domainLifecycle.run();
          } catch (error) {
            console.warn("[domain-lifecycle] failed", error);
          }
          try {
            await isolationBuy.resume();
          } catch (error) {
            console.warn("[isolation-buy] resume failed", error);
          }
        } catch (error) {
          console.warn("[pod-controls] failed", error);
        }
      }
      let isolationRigResult: unknown = null;
      if (config.enableIsolationRig) {
        try {
          isolationRigResult = await isolationRig.run();
        } catch (error) {
          console.warn("[isolation-rig] failed", error);
        }
      }
      let isolationBranchResult: unknown = null;
      if (config.enableIsolationBranch) {
        try {
          isolationBranchResult = await isolationBranch.run();
        } catch (error) {
          console.warn("[isolation-branch] failed", error);
        }
      }
      if (config.enableCopyIsolation) {
        try {
          for (const run of state.listIsolationRuns()) {
            if (!run.teardownStarted) continue;
            await copyIsolation.runForCampaign(run);
          }
        } catch (error) {
          console.warn("[copy-isolation] poll failed", error);
        }
      }
      return {
        monitor: monitorResult,
        remediation: remediationResult,
        heldPlacementTests: heldTestsResult,
        restPlacementTests: restTestsResult,
        warmupGate: warmupGateResult,
        testReconcile: reconcileResult,
        dnsAudit: dnsAuditResult,
        campaignAudit: campaignAuditResult,
        bounceInvestigate: bounceInvestigateResult,
        podControls: podControlResult,
        isolationRig: isolationRigResult,
        isolationBranch: isolationBranchResult,
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
  if (!cron.validate(config.cronHealth)) {
    throw new Error(`Invalid CRON_HEALTH expression: ${config.cronHealth}`);
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
  if (!cron.validate(config.cronDeliveryWatch)) {
    throw new Error(
      `Invalid CRON_DELIVERY_WATCH expression: ${config.cronDeliveryWatch}`,
    );
  }
  const sendVolumeSchedules = parseSchedules(config.cronSendVolume);
  for (const expression of sendVolumeSchedules) {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid CRON_SEND_VOLUME expression: ${expression}`);
    }
  }

  cron.schedule(config.cronScan, () => {
    void runScan("cron").catch((error) => {
      console.error("[scan] Unhandled cron error", error);
      feedBugRemediator("scan-cron", error);
    });
  });

  cron.schedule(config.cronMonitor, () => {
    void runMonitor({ remediate: true }).catch((error) => {
      console.error("[monitor] Unhandled cron error", error);
      feedBugRemediator("monitor-cron", error);
    });
  });

  // Client day brief (sent / bounce% / spam% + resting vs active) posts at
  // fixed local times. America/New_York so the times track EST/EDT.
  for (const expression of sendVolumeSchedules) {
    cron.schedule(
      expression,
      () => {
        void clientDayBrief.run().catch((error) => {
          console.error("[client-day] Unhandled cron error", error);
        });
      },
      { timezone: "America/New_York" },
    );
  }

  if (config.enableDeliveryWatch) {
    cron.schedule(
      config.cronDeliveryWatch,
      () => {
        void deliveryWatch.run().catch((error) => {
          console.error("[delivery-watch] Unhandled cron error", error);
        });
      },
      { timezone: "America/New_York" },
    );
  }

  if (config.enableCampaignHealth) {
    cron.schedule(config.cronHealth, () => {
      void runHealth().catch((error) => {
        console.error("[health] Unhandled cron error", error);
        feedBugRemediator("health-cron", error);
      });
    });
    // Kick shortly after boot so thin/paused campaigns do not wait 15m.
    setTimeout(() => {
      void runHealth().catch((error) => {
        console.error("[health] Boot kick failed", error);
      });
    }, 45_000);
  }

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
  app.post(
    "/slack/interactions",
    express.raw({ type: "application/x-www-form-urlencoded" }),
    async (req, res) => {
      try {
        const rawBody = Buffer.isBuffer(req.body)
          ? req.body.toString("utf8")
          : String(req.body ?? "");
        if (
          !slackSignatureValid({
            signingSecret: config.slackSigningSecret,
            timestamp: String(req.header("x-slack-request-timestamp") ?? ""),
            rawBody,
            signature: String(req.header("x-slack-signature") ?? ""),
          })
        ) {
          res.status(401).json({ error: "Bad Slack signature" });
          return;
        }
        const payloadRaw = new URLSearchParams(rawBody).get("payload");
        if (!payloadRaw) {
          res.status(400).json({ error: "Missing payload" });
          return;
        }
        const payload = JSON.parse(payloadRaw) as {
          user?: { id?: string; name?: string; username?: string };
          actions?: Array<{ value?: string }>;
        };
        const parsed = parseIsolationActionValue(
          payload.actions?.[0]?.value ?? "",
        );
        if (!parsed) {
          res.status(200).json({ text: "That button is not one I handle." });
          return;
        }
        const role = slackRoleOf(
          payload.user?.id,
          config.slackJoshUserIds,
          config.slackCaydenUserIds,
        );
        const name =
          role === "owner"
            ? "Josh"
            : role === "operator"
              ? "Cayden"
              : payload.user?.name || payload.user?.username || "unknown";
        if (
          role === "unknown" &&
          (parsed.kind === "buy_domains" || parsed.kind === "retire_domain")
        ) {
          res.status(200).json({
            text: "I do not recognize this Slack user as Josh. Approve in Railway → /ops.",
          });
          return;
        }
        const result = await isolationExecute.decide(
          parsed.id,
          parsed.decision,
          { name, role },
        );
        res.status(200).json({ text: result.message });
      } catch (error) {
        console.error("[slack-interactions]", error);
        res.status(200).json({
          text: error instanceof Error ? error.message : "That tap failed.",
        });
      }
    },
  );
  app.get("/slack/oauth", async (req, res) => {
    const error = String(req.query.error ?? "");
    if (error) {
      res.status(400).send(`Slack install was cancelled (${error}).`);
      return;
    }
    const code = String(req.query.code ?? "").trim();
    if (!code) {
      res.status(400).send("Missing Slack install code.");
      return;
    }
    if (!config.slackClientId || !config.slackClientSecret) {
      res.status(503).send("Slack app credentials are not on this service yet.");
      return;
    }
    try {
      const installed = await exchangeSlackOauth({
        clientId: config.slackClientId,
        clientSecret: config.slackClientSecret,
        code,
        redirectUri: config.slackOauthRedirectUri,
      });
      await writeSlackBotTokenFile(config.slackBotTokenFile, installed.botToken);
      try {
        await slack.send(
          "Deliverability Wizard is now its own Slack app. Approve / retire / buy buttons on new messages will work here. Invite *Deliverability Wizard* to this channel if you do not see this note.",
        );
      } catch (postError) {
        console.warn("[slack-oauth] installed but could not post yet", postError);
      }
      res
        .status(200)
        .type("html")
        .send(
          "<p>Installed. You can close this tab. Check the deliverability channel for a confirmation.</p>",
        );
    } catch (installError) {
      console.error("[slack-oauth]", installError);
      res
        .status(400)
        .send(
          installError instanceof Error
            ? installError.message
            : "Slack install failed.",
        );
    }
  });
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
      cursorAssistant,
      isolationExecute,
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
      enableCampaignHealth: config.enableCampaignHealth,
      cronHealth: config.cronHealth,
      pendingResumes: Object.keys(s.pendingResumes ?? {}).length,
      lastHealthAt: s.lastHealthAt,
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
        cronHealth: config.cronHealth,
        enableCampaignHealth: config.enableCampaignHealth,
        enableHeldPlacementTests: config.enableHeldPlacementTests,
        enableClientRest: config.enableClientRest,
        enableRestPlacementTests: config.enableRestPlacementTests,
        enableGenericSendRest: config.enableGenericSendRest,
        enableRestBaselineRebuild: config.enableRestBaselineRebuild,
        freshInboxWarmupDays: config.freshInboxWarmupDays,
        bounceRateWarnThreshold: config.bounceRateWarnThreshold,
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
        enableLegacyMailboxPulls: config.enableLegacyMailboxPulls,
        enableCopyCanary: config.enableCopyCanary,
        copyCanaryPerCampaign: config.copyCanaryPerCampaign,
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
      if (mode === "health" || mode === "campaign-health") {
        const result = await runHealth();
        res.json({ ok: true, mode: "health", result });
        return;
      }
      if (mode === "top-up" || mode === "topup") {
        const result = await runCampaignTopUp();
        res.json({ ok: true, mode: "top-up", result });
        return;
      }
      if (mode === "campaign-audit" || mode === "audit-campaigns") {
        assertRuntimeSecrets(config);
        const result = await campaignAudit.run(config.minCampaignSenders);
        res.json({ ok: true, mode: "campaign-audit", result });
        return;
      }
      if (mode === "fan-out" || mode === "client-fanout") {
        assertRuntimeSecrets(config);
        if (healthInFlight || topUpInFlight || manualRotationInFlight) {
          res.json({
            ok: true,
            mode: "fan-out",
            result: { skipped: true, reason: "already-running" },
          });
          return;
        }
        const rest = await runRestGates();
        const result = await clientFanOut.run();
        res.json({ ok: true, mode: "fan-out", result: { ...rest, fanOut: result } });
        return;
      }
      if (mode === "held-tests" || mode === "held-placement-tests") {
        assertRuntimeSecrets(config);
        const result = await heldPlacementTests.run();
        res.json({ ok: true, mode: "held-tests", result });
        return;
      }
      if (mode === "client-rest" || mode === "rest") {
        assertRuntimeSecrets(config);
        const result = await clientRest.run();
        res.json({ ok: true, mode: "client-rest", result });
        return;
      }
      if (
        mode === "rest-baseline" ||
        mode === "hold-rebuild" ||
        mode === "rest-baseline-rebuild"
      ) {
        assertRuntimeSecrets(config);
        const result = await restBaselineRebuild.run();
        res.json({ ok: true, mode: "rest-baseline", result });
        return;
      }
      if (mode === "rest-tests" || mode === "rest-placement-tests") {
        assertRuntimeSecrets(config);
        const result = await heldPlacementTests.runResting();
        res.json({ ok: true, mode: "rest-tests", result });
        return;
      }
      if (mode === "client-day" || mode === "send-volume" || mode === "day-brief") {
        assertRuntimeSecrets(config);
        const result = await clientDayBrief.run();
        res.json({ ok: true, mode: "client-day", result });
        return;
      }
      if (
        mode === "bounce-investigate" ||
        mode === "campaign-bounce-investigate"
      ) {
        assertRuntimeSecrets(config);
        const result = await bounceInvestigate.run();
        res.json({ ok: true, mode: "bounce-investigate", result });
        return;
      }
      if (mode === "pod-controls" || mode === "pod-control") {
        assertRuntimeSecrets(config);
        const result = await podControls.run();
        res.json({ ok: true, mode: "pod-controls", result });
        return;
      }
      if (mode === "isolation-rig" || mode === "rig") {
        assertRuntimeSecrets(config);
        const result = await isolationRig.run({
          force:
            String(req.query.force ?? req.body?.force ?? "") === "1" ||
            String(req.query.force ?? req.body?.force ?? "").toLowerCase() ===
              "true",
        });
        res.json({ ok: true, mode: "isolation-rig", result });
        return;
      }
      if (mode === "isolation" || mode === "isolation-branch") {
        assertRuntimeSecrets(config);
        const campaignId = Number(
          req.query.campaignId ?? req.body?.campaignId ?? "",
        );
        const result = Number.isFinite(campaignId) && campaignId > 0
          ? {
              run: await isolationBranch.evaluate(campaignId),
            }
          : await isolationBranch.run();
        res.json({ ok: true, mode: "isolation", result });
        return;
      }
      if (mode === "delivery-watch" || mode === "copy-watch") {
        assertRuntimeSecrets(config);
        const result = await deliveryWatch.run();
        res.json({ ok: true, mode: "delivery-watch", result });
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
      if (
        mode === "mailbox-settings" ||
        mode === "mailbox-settings-enforce" ||
        mode === "settings"
      ) {
        assertRuntimeSecrets(config);
        const result = await mailboxSettings.run();
        res.json({ ok: true, mode: "mailbox-settings", result });
        return;
      }
      if (mode === "reconcile" || mode === "test-reconcile") {
        const result = await runTestReconcile();
        res.json({ ok: true, mode: "reconcile", result });
        return;
      }
      if (
        mode === "audit-placements" ||
        mode === "audit-placement" ||
        mode === "placement-audit"
      ) {
        assertRuntimeSecrets(config);
        const result = await placementAudit.runPlacements();
        res.json({ ok: true, mode: "audit-placements", result });
        return;
      }
      if (mode === "audit-sends" || mode === "send-audit") {
        assertRuntimeSecrets(config);
        const date =
          typeof req.body?.date === "string" && req.body.date
            ? String(req.body.date).slice(0, 10)
            : new Date().toISOString().slice(0, 10);
        const result = await placementAudit.runSends(date);
        res.json({ ok: true, mode: "audit-sends", result });
        return;
      }
      if (mode === "audit-bcp" || mode === "bcp-audit") {
        assertRuntimeSecrets(config);
        const result = await placementAudit.runBcpGenerics();
        res.json({ ok: true, mode: "audit-bcp", result });
        return;
      }
      if (
        mode === "bcp-restore" ||
        mode === "restore-bcp" ||
        mode === "bcp-client-restore"
      ) {
        assertRuntimeSecrets(config);
        const confirm = String(req.body?.confirm ?? "");
        const dryRun =
          req.body?.dryRun === true ||
          req.body?.dryRun === "true" ||
          confirm !== "RESTORE";
        if (!dryRun && confirm !== "RESTORE") {
          res.status(400).json({
            ok: false,
            error: 'Pass { "confirm": "RESTORE" } for a live run (or dryRun: true)',
          });
          return;
        }
        const result = await bcpClientRestore.run({ dryRun });
        res.json({ ok: true, mode: "bcp-restore", dryRun, result });
        return;
      }
      if (mode === "audit-day" || mode === "day-audit") {
        assertRuntimeSecrets(config);
        const result = await placementAudit.runDay();
        res.json({ ok: true, mode: "audit-day", result });
        return;
      }
      if (mode === "bug-remediate" || mode === "bug-remediator") {
        const errors = Array.isArray(req.body?.errors)
          ? req.body.errors.map(String)
          : req.body?.error
            ? [String(req.body.error)]
            : [];
        if (!errors.length) {
          res.status(400).json({
            ok: false,
            error:
              "Pass { errors: string[] } or { error: string } — or rely on cron to feed failures automatically",
          });
          return;
        }
        const result = await bugRemediator.observeMany(
          String(req.body?.source ?? "manual"),
          errors,
        );
        res.json({
          ok: true,
          mode: "bug-remediate",
          enabled: bugRemediator.enabled(),
          result,
        });
        return;
      }
      if (
        mode === "sync-placement-state" ||
        mode === "sync-tested" ||
        mode === "sync-placements"
      ) {
        // Mark campaigns that already have an ACTIVE automated SmartDelivery
        // test so a later scan does not create duplicates. Used after manual
        // / API backfills when state.testedCampaigns is behind reality.
        assertRuntimeSecrets(config);
        const listed = normalizeTestList(await smartDelivery.listTests({}));
        const enriched = await smartDelivery.enrichCampaignIds(listed);
        const byCampaign = new Map<
          string,
          { name: string; testIds: string[] }
        >();
        for (const test of enriched) {
          if (!isAutomatedTest(test) || !isTestStoppable(test)) continue;
          const cid = campaignIdOf(test);
          const tid = testIdOf(test);
          if (!cid || !tid) continue;
          const row = byCampaign.get(cid) ?? {
            name: String(test.test_name ?? `Campaign ${cid}`),
            testIds: [],
          };
          row.testIds.push(tid);
          byCampaign.set(cid, row);
        }
        let campaigns = [] as Array<{ id: number; name?: string | null }>;
        try {
          campaigns = await smartlead.listCampaigns();
        } catch (error) {
          console.warn("[sync-placement-state] listCampaigns failed", error);
        }
        const nameById = new Map(
          campaigns.map((c) => [String(c.id), String(c.name ?? "")]),
        );
        let marked = 0;
        for (const [cid, row] of byCampaign) {
          const campaignName =
            nameById.get(cid) ||
            row.name.replace(/^Auto:\s*/i, "").replace(/\s*\(\d+\/\d+\)\s*$/, "") ||
            `Campaign ${cid}`;
          const existing = state.get().testedCampaigns[cid];
          const mergedIds = [
            ...new Set([...(existing?.testIds ?? []), ...row.testIds]),
          ];
          state.markCampaignTested({
            campaignId: Number(cid),
            campaignName,
            testedAt: existing?.testedAt ?? new Date().toISOString(),
            testIds: mergedIds,
            mailboxCount: existing?.mailboxCount ?? 0,
            testsCreated: mergedIds.length,
          });
          marked += 1;
        }
        await state.save();
        res.json({
          ok: true,
          mode: "sync-placement-state",
          activeAutoCampaigns: byCampaign.size,
          marked,
          campaignIds: [...byCampaign.keys()].map(Number).sort((a, b) => a - b),
        });
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
    // Read-only campaign audit at boot; staffing mutations are owned by the
    // health cron (boot kick + CRON_HEALTH) so we do not double-write.
    if (secretsReady) {
      void (async () => {
        try {
          await manualRotation.recoverStaleReservations();
          await campaignAudit.run(config.minCampaignSenders);
        } catch (error) {
          console.warn("[boot] campaign audit failed", error);
        }
      })();
    }
    console.log(
      `[boot] Placement tests: ${config.autoPlacementTests ? `RECURRING every ${config.placementTestEveryDays}d while campaign in [${config.autoTestActiveStatuses.join(",")}]` : "one-off manual"}${config.enableTestReconciler ? " (auto-stop on inactive)" : ""}`,
    );
    console.log(`[boot] Monitor cron: ${config.cronMonitor} (measure/remediate/DNS)`);
    console.log(
      `[boot] Campaign health: ${config.enableCampaignHealth ? `ENABLED (${config.cronHealth}; floor ${config.minCampaignSenders} connected+inboxing; auto-resume protective pauses)` : "disabled"}`,
    );
    console.log(
      `[boot] Held placement tests (D39): ${config.enableHeldPlacementTests ? "ENABLED (separate SmartDelivery tests for pulled mailboxes; not re-attached to campaigns)" : "disabled"}`,
    );
    console.log(
      `[boot] Sender rest (D43): ${config.enableClientRest ? "ENABLED (per-client A/B, 2 weeks on / 2 weeks off)" : "disabled"}; generics ${config.enableGenericSendRest ? `sit after ${config.genericSendRestDays}d live send` : "no send-clock"}; hold rebuild (D44) ${config.enableRestBaselineRebuild ? (state.getRestBaselineRebuiltAt() ? `done ${state.getRestBaselineRebuiltAt()}` : "PENDING first health") : "disabled"}`,
    );
    console.log(
      `[boot] Mailbox settings: ${config.enforceMailboxSettings ? `ENFORCED (${config.messagePerDay}/day warmups-not-included, ${config.mailboxMinTimeGapMins}m min gap every health pass; signatures/warmup every 6h)` : "not enforced"}`,
    );
    console.log(
      `[boot] Campaign top-up: ${config.enableCampaignTopUp ? `ENABLED via health (floor ${config.minCampaignSenders} staffable${config.topUpExcludeCampaigns.length ? `, excluding ${config.topUpExcludeCampaigns.join(", ")}` : ""})` : "disabled"}`,
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
      `[boot] Warmup gate: ${config.enableWarmupGate ? `ENABLED (min ${config.campaignMinWarmupDays}d + HOLD strip, runs with monitor)` : "disabled (D51 kill-only pull)"}`,
    );
    console.log(
      `[boot] Live mailbox pull: ${config.enableLegacyMailboxPulls ? "LEGACY (placement/bounce/HOLD)" : "KILL-ONLY (domain retire + backfill)"}`,
    );
    console.log(
      `[boot] Copy canaries: ${config.enableCopyCanary ? `ENABLED (${config.copyCanaryPerCampaign} unwarmed per campaign, campaign copy)` : "disabled"}`,
    );
    console.log(`[boot] InboxKit: ${inboxkit ? "configured" : "not configured"}`);
    console.log(
      `[boot] Ops UI: ${config.opsUiEnabled ? (opsAuth.isConfigured() ? "ENABLED at /ops" : `disabled until configured (${opsAuth.configurationError()})`) : "disabled"}`,
    );
    console.log(
      `[boot] Ops Cursor assistant: ${cursorAssistant ? `ENABLED (${config.cursorAgentModelId} ${config.cursorAgentModelParams.map((p) => `${p.id}=${p.value}`).join(",")})` : "disabled (set CURSOR_API_KEY)"}`,
    );
    console.log(
      `[boot] Auto bug remediator: ${bugRemediator.enabled() ? `ENABLED (min ${config.bugRemediatorMinHits} hits, ${config.bugRemediatorCooldownHours}h cooldown, auto-merge ${config.bugRemediatorAutoMerge ? "on" : "off"})` : "disabled (needs ENABLE_BUG_REMEDIATOR + CURSOR_API_KEY)"}`,
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
