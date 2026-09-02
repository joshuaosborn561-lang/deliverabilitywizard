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
  SWAP_EDIT_CALLBACK_ID,
  SWAP_EDIT_INPUT_BLOCK_ID,
  swapTextFromViewSubmission,
} from "./lib/slackSwapEdit.js";
import { copySwapProof } from "./lib/isolationProof.js";
import {
  publicBaseUrlFromEnv,
  slackInstallHref,
  verifySlackActionLink,
} from "./lib/slackActionLink.js";
import {
  dismissPendingSignatureAsks,
  remindPendingIsolationActions,
} from "./lib/isolationActions.js";
import {
  exchangeSlackOauth,
  writeSlackBotTokenFile,
} from "./lib/slackOauth.js";
import { StateStore, type PoolProvisionPhase } from "./state/store.js";
import {
  InventoryBook,
  type InventorySnapshot,
} from "./services/inventory.js";
import { SpendGateway } from "./lib/spendGateway.js";
import { CampaignScanner } from "./services/campaignScanner.js";
import { ResultMonitor } from "./services/resultMonitor.js";
import { DnsAuditService } from "./services/dnsAudit.js";
import { CampaignAuditService } from "./services/campaignAudit.js";
import { CampaignCheckService } from "./services/campaignCheck.js";
import { CampaignTopUpService } from "./services/campaignTopUp.js";
import { CampaignHealthService } from "./services/campaignHealth.js";
import { ClientFanOutService } from "./services/clientFanOut.js";
import { OneClientMembershipService } from "./services/oneClientMembership.js";
import { CampaignClientTagService } from "./services/campaignClientTag.js";
import { UnpauseAfterSigQaService } from "./services/unpauseAfterSigQa.js";
import { CampaignBounceAutostopService } from "./services/campaignBounceAutostop.js";
import { parseSchedules } from "./services/sendVolume.js";
import { ClientDayBriefService } from "./services/clientDayBrief.js";
import { ClientRestService } from "./services/clientRest.js";
import { GenericSendRestService } from "./services/genericSendRest.js";
import { MailboxSettingsService } from "./services/mailboxSettings.js";
import { PoolProvisioner } from "./services/poolProvisioner.js";
import { AccountReconnectService } from "./services/accountReconnect.js";
import { WarmupGateService } from "./services/warmupGate.js";
import { TestReconciler } from "./services/testReconciler.js";
import { PlacementAuditService } from "./services/placementAudit.js";
import {
  FleetSummaryService,
  PlacementResultsService,
} from "./services/opsReporting.js";
import { CursorCloudClient } from "./clients/cursorCloud.js";
import { OpsAuth } from "./ops/auth.js";
import { CursorAssistantService } from "./ops/cursorAssistant.js";
import { createOpsRouter } from "./ops/router.js";
import { BugRemediator } from "./services/bugRemediator.js";
import { MutationQueue } from "./lib/mutationQueue.js";
import { PodControlService } from "./services/podControls.js";
import { IsolationRigService } from "./services/isolationRig.js";
import { CopyIsolationService } from "./services/copyIsolation.js";
import { IsolationBranchService } from "./services/isolationBranch.js";
import { DeliveryWatchService } from "./services/deliveryWatch.js";
import { IsolationBuyService } from "./services/isolationBuy.js";
import { CopyCanaryBuyService } from "./services/copyCanaryBuy.js";
import { IsolationExecuteService } from "./services/isolationExecute.js";
import { DomainLifecycleService } from "./services/domainLifecycle.js";
import { CopyCanaryService } from "./services/copyCanary.js";
import { LeadRunoutService } from "./services/leadRunout.js";
import { SendingInfraService } from "./services/sendingInfra.js";
import { canonBoard } from "./lib/canonCompliance.js";
import { STAGE_OVERDUE_WINDOWS_MS, overdueStages } from "./lib/stageWindows.js";
import { alertStageAnomalies } from "./services/opsAlerts.js";
import {
  deployIdentityLine,
  deployIdentityProblem,
  readDeployIdentity,
} from "./lib/deployIdentity.js";
import { PodTagService } from "./services/podTags.js";
import { DomainClientAuditService } from "./services/domainClientAudit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();
  const state = new StateStore(config.stateFilePath);
  await state.load();
  // D130 — the hold/swap rotation system is retired (kill-only, D51/D59).
  // Residue in these maps only suppresses staffing; drain it once, loudly.
  {
    const heldResidue = Object.keys(state.get().heldInboxes).length;
    const swapResidue = state.clearAllSwaps();
    const holdCleared = state.clearAllHeldInboxes();
    if (heldResidue || swapResidue) {
      console.warn(
        `[boot] D130 drain: cleared ${holdCleared} leftover hold record(s) and ${swapResidue} swap reservation(s) — freed inboxes rejoin staffing on the next health pass`,
      );
      await state.save();
    }
  }
  // D131 — a stage deleted from the code must not alarm forever from its
  // persisted record (morning-activate et al. sat OVERDUE after Phase 2/3).
  {
    const ghostStages = Object.keys(state.listStageHealth()).filter(
      (name) => !(name in STAGE_OVERDUE_WINDOWS_MS),
    );
    if (ghostStages.length) {
      for (const name of ghostStages) state.dropStageHealth(name);
      console.warn(
        `[boot] D131 prune: dropped stageHealth for deleted stage(s): ${ghostStages.join(", ")}`,
      );
      await state.save();
    }
  }

  // D149 — who am I? Railway injects git metadata into GitHub-push builds;
  // a build without it is the stale-snapshot redeployer's signature.
  const deployIdentity = readDeployIdentity();

  const secretsReady = configIsReady(config);
  if (!secretsReady) {
    console.warn(
      "[boot] SMARTLEAD_API_KEY and/or Slack credentials not set yet — HTTP health is up, scans will fail until secrets are configured.",
    );
  }

  const smartlead = new SmartleadClient(config.smartleadApiKey || "missing");
  // D132 — one Smartlead account book shared by the health pass, the hourly
  // campaign check, the 6-hour audit, the /ops board, and the Slack taps.
  const inventoryBook = new InventoryBook(smartlead);
  // Serialise Smartlead writes across health / remediation / settings so
  // overlapping crons do not stampede into 429s (D25).
  smartlead.setMutationQueue(new MutationQueue(400));
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
    actionLinkSecret: config.slackSigningSecret,
    publicBaseUrl: publicBaseUrlFromEnv(process.env),
  });
  const scanner = new CampaignScanner(config, smartlead, smartDelivery, slack, state);
  const monitor = new ResultMonitor(config, smartDelivery, smartlead, slack, state);
  const spendGateway = new SpendGateway(state, slack, config.requireSpendApproval);
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

  let scanInFlight: Promise<unknown> | null = null;
  let monitorInFlight: Promise<unknown> | null = null;
  let poolInFlight: Promise<unknown> | null = null;
  let reconnectInFlight: Promise<unknown> | null = null;
  let warmupGateInFlight: Promise<unknown> | null = null;
  let reconcileInFlight: Promise<unknown> | null = null;
  let topUpInFlight: Promise<unknown> | null = null;
  let healthInFlight: Promise<unknown> | null = null;
  let bounceAutostopInFlight: Promise<unknown> | null = null;
  let opsCheckInFlight: Promise<{
    monitor: unknown;
    dns: unknown;
    campaigns: unknown;
  }> | null = null;

  const runScan = async (trigger: "cron" | "manual" | "canon-sweep") => {
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

  const runPoolProvision = async () => {
    if (healthInFlight) {
      console.log(
        "[pool-provision] Health pass running — skipping overlapping trigger",
      );
      return { skipped: true as const, reason: "health-running" };
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

  const runWarmupGate = async (inventory?: InventorySnapshot) => {
    assertRuntimeSecrets(config);
    if (warmupGateInFlight) {
      console.log("[warmup-gate] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    warmupGateInFlight = warmupGate.run({ inventory }).finally(() => {
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

  const leadRunout = new LeadRunoutService(config, smartlead, slack, state);
  const sendingInfra = new SendingInfraService(
    config,
    smartDelivery,
    slack,
    state,
  );
  const dnsAudit = new DnsAuditService(smartlead, slack, state);
  const mailboxSettings = new MailboxSettingsService(
    config,
    smartlead,
    slack,
    state,
  );
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
  const copyCanary = new CopyCanaryService(
    config,
    smartlead,
    smartDelivery,
    slack,
    state,
  );
  const oneClientMembership = new OneClientMembershipService(
    config,
    smartlead,
    state,
  );
  const campaignClientTag = new CampaignClientTagService(config, smartlead);
  const unpauseAfterSigQa = new UnpauseAfterSigQaService(
    config,
    smartlead,
    smartDelivery,
    state,
  );
  // D85 — the standalone BounceAutopauseService is retired, and since D157
  // nothing writes Smartlead autopause at all: the API field is dead
  // (handler-discarded), so the loop only detects and receipts.
  const campaignBounceAutostop = new CampaignBounceAutostopService(
    config,
    smartlead,
    state,
    slack,
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
  campaignBounceAutostop.setIsolationBranch(isolationBranch);
  const podControls = new PodControlService(
    config,
    smartlead,
    smartDelivery,
    slack,
    state,
    inventoryBook,
  );
  const podTags = new PodTagService(config, smartlead, state, inventoryBook);
  const domainClientAudit = new DomainClientAuditService(
    config,
    state,
    inventoryBook,
    smartlead,
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
  const copyCanaryBuy = new CopyCanaryBuyService(
    config,
    inboxkit,
    porkbun,
    smartlead,
    state,
    spendGateway,
  );
  const isolationExecute = new IsolationExecuteService(
    config,
    smartlead,
    slack,
    state,
    isolationBuy,
    inventoryBook,
    copyCanaryBuy,
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
    inventoryBook,
  );
  const campaignCheck = new CampaignCheckService(
    config,
    smartlead,
    smartDelivery,
    state,
    inventoryBook,
    slack,
  );
  const clientDayBrief = new ClientDayBriefService(
    config,
    smartlead,
    smartDelivery,
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
    inventoryBook,
    state,
  );
  const fleetSummary = new FleetSummaryService(inventoryBook, state);
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

  /**
   * D84 — watchdog. Every scheduled stage runs through here so a failure is
   * recorded (per-stage lastOkAt / consecutiveFailures in state, surfaced on
   * /health) instead of vanishing into a console.warn. Production ran for
   * days with fan-out and campaign-audit dying on 429s and nothing said so.
   */
  const stage = async <T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T | null> => {
    const startedAt = Date.now();
    try {
      const out = await fn();
      state.recordStageOk(name, Date.now() - startedAt);
      return out;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.recordStageError(name, message);
      console.warn(`[watchdog] stage ${name} FAILED: ${message}`);
      feedBugRemediator(`stage-${name}`, error);
      return null;
    }
  };

  const logCanonScoreboard = (): void => {
    const counts = new Map<string, number>();
    for (const record of state.listCampaignChecks()) {
      for (const finding of record.findings ?? []) {
        const kind = finding.split(":")[0] ?? "unknown";
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
    }
    const summary = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `${kind}=${n}`)
      .join(" ");
    console.log(`[canon] open findings: ${summary || "none"}`);
    const fleetDown = state.getCanaryFleetDown();
    if (fleetDown) {
      console.warn(
        `[canon] canary fleet DOWN since ${fleetDown.since} (${fleetDown.fleetSize} known email(s), 0 connected) — placement measurement is blind`,
      );
    }
    // D131/D149 — overdue is judged against the stage's own cadence by
    // overdueStages, the same judgement the Slack pager uses.
    for (const row of overdueStages(state.listStageHealth())) {
      console.warn(
        `[watchdog] stage ${row.name} OVERDUE — last ok ${row.lastOkAt ?? "never"}; failures=${row.consecutiveFailures}; lastError=${row.lastError ?? "none"}`,
      );
    }
  };

  const runRestGates = async (inventory?: InventorySnapshot) => {
    // D129 — the D44/D59/D61 one-shots ran in Aug 2026 and are deleted;
    // rest gates are just the living D43 loops now.
    const restResult = config.enableClientRest
      ? await stage("client-rest", () => clientRest.run({ inventory }))
      : null;
    const genericRest = config.enableGenericSendRest
      ? await stage("generic-rest", () => genericSendRest.run({ inventory }))
      : null;
    return { clientRest: restResult, genericRest };
  };

  const runCampaignTopUp = async () => {
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
    if (healthInFlight) {
      console.log("[health] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    healthInFlight = (async () => {
      const passStart = Date.now();

      // D84 — one Smartlead inventory per pass. Every stage below shares it;
      // mutating stages keep it truthful in place (recordMembership). Before
      // this, ~8 stages each refetched the full account book and the pass
      // starved itself into 429s.
      // D132 — the per-pass fetch goes through the shared book's partial-read
      // gate, so a shrunken read serves the last accepted book instead.
      const inventory = await stage("inventory", () => inventoryBook.fetchFresh());
      if (!inventory) {
        console.warn("[health] inventory fetch failed — skipping this pass");
        await state.save();
        return { skipped: true as const, reason: "inventory-failed" };
      }

      const rest = await runRestGates(inventory);

      await stage("client-tag", () => campaignClientTag.run({ inventory }));
      const oneClientResult = await stage("one-client", () =>
        oneClientMembership.run({ inventory }),
      );
      await stage("qa-unpause", () => unpauseAfterSigQa.run({ inventory }));

      let campaignCheckResult: unknown = null;
      if (config.enableCampaignCheck) {
        campaignCheckResult = await stage("campaign-check-first", () =>
          campaignCheck.run({ mode: "first", inventory }),
        );
      }

      if (config.enableWarmupGate) {
        await stage("warmup-gate", () => runWarmupGate(inventory));
      }

      const healthResult = await stage("campaign-health", () =>
        campaignHealth.run({ inventory }),
      );

      // D84 / D116 — placement coverage is fixed on the pass that finds
      // it, not only at the daily 9:00 scan. The D84 hourly throttle
      // left new ACTIVE campaigns uncovered for ~55 minutes after the
      // 04:54 scan (live 2026-08-26: no_placement_test=20).
      if (config.autoPlacementTests) {
        const missingTest = state
          .listCampaignChecks()
          .some((record) =>
            (record.findings ?? []).some((f) => f.startsWith("no_placement_test")),
          );
        if (missingTest) {
          await stage("scan-backfill", () => runScan("canon-sweep"));
        }
      }

      // D89 — serving inboxes missing a living known-good canary get a
      // pod-control test on this pass (throttled hourly), not only at the
      // 6-hour monitor.
      if (config.enablePodControls) {
        const missingKnownGood = state
          .listCampaignChecks()
          .some((record) =>
            (record.findings ?? []).some((f) =>
              f.startsWith("inbox_missing_known_good"),
            ),
          );
        const lastPodAt = state.getIsolation().lastPodControlAt;
        const podAgeMs = lastPodAt
          ? Date.now() - Date.parse(lastPodAt)
          : Number.POSITIVE_INFINITY;
        if (missingKnownGood && podAgeMs >= 55 * 60 * 1000) {
          await stage("pod-cover", () => podControls.run());
        }
      }

      let reconnectResult: unknown = null;
      if (config.enableAccountReconnect) {
        reconnectResult = await stage("reconnect", () => runReconnect());
      }

      // D30/D35/D83: gap + daily volume + canary warmup-off every health pass.
      // Full signature/everyone-else warmup stays throttled so it cannot
      // starve the 15-minute staffing loop.
      let mailboxGapResult: unknown = null;
      let mailboxSettingsResult: unknown = null;
      if (config.enforceMailboxSettings) {
        mailboxGapResult = await stage("mailbox-gap", () =>
          mailboxSettings.runGapEnforce({ inventory }),
        );

        const lastSettingsAt = state.get().lastMailboxSettingsAt;
        const settingsAgeMs = lastSettingsAt
          ? Date.now() - Date.parse(lastSettingsAt)
          : Number.POSITIVE_INFINITY;
        if (settingsAgeMs >= MAILBOX_SETTINGS_EVERY_MS) {
          mailboxSettingsResult = await stage("mailbox-settings-full", () =>
            mailboxSettings.run({ mode: "full", inventory }),
          );
          if (mailboxSettingsResult) {
            state.setLastMailboxSettingsAt(new Date().toISOString());
          }
        } else {
          console.log(
            `[health] Skipping full mailbox-settings (last ${lastSettingsAt ?? "never"}; due every 6h; gap enforce already ran)`,
          );
        }
      }

      logCanonScoreboard();
      const passMs = Date.now() - passStart;
      if (passMs > 15 * 60 * 1000) {
        console.warn(
          `[watchdog] health pass took ${(passMs / 60000).toFixed(1)} min — longer than its 15m cadence`,
        );
      }
      state.recordStageOk("health-pass", passMs);
      // D149 — the watch lives here, not in a chat session: page Slack
      // once per overdue-stage episode, and once again on recovery.
      await alertStageAnomalies({ store: state, slack, dryRun: config.dryRun });
      await state.save();

      return {
        clientRest: rest.clientRest,
        genericRest: rest.genericRest,
        oneClient: oneClientResult,
        campaignCheck: campaignCheckResult,
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

  const runBounceAutostop = async () => {
    assertRuntimeSecrets(config);
    if (!config.enableCampaignBounceAutostop) {
      return { skipped: true as const, reason: "disabled" };
    }
    if (bounceAutostopInFlight) {
      console.log("[bounce-autostop] Already running — skipping overlapping trigger");
      return { skipped: true as const, reason: "already-running" };
    }
    bounceAutostopInFlight = (async () => {
      return campaignBounceAutostop.run();
    })().finally(() => {
      bounceAutostopInFlight = null;
    });
    return bounceAutostopInFlight;
  };

  const runOpsDeliverability = async () => {
    if (opsCheckInFlight || monitorInFlight) {
      throw new Error("A deliverability monitor is already running.");
    }
    opsCheckInFlight = (async () => {
      const monitorResult = await monitor.run();
      const dnsResult = await dnsAudit.run({ alert: false });
      const campaignResult = await campaignAudit.run();
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
      // D131 — every monitor stage is watchdogged like the health pass:
      // a silent 429 death shows up in stageHealth instead of a swallowed
      // console.warn (D84 covered only the 15-minute loop).
      // D135/D143 — pod-tags spends the fresh rate window FIRST. Ninth in
      // line it lost the whole window to placement pulls and 429'd three
      // consecutive passes (00:22, 06:20, 12:17 on 2026-08-27) even with
      // spaced writes and ~91s of retry runway.
      if (config.enablePodControls) {
        await stage("pod-tags", () => podTags.run());
      }
      const monitorResult = await stage("monitor-results", () => monitor.run());
      feedBugRemediator(
        "monitor",
        (monitorResult as { errors?: string[] })?.errors ?? [],
      );
      let warmupGateResult: unknown = null;
      if (config.enableWarmupGate) {
        warmupGateResult = await stage("warmup-gate", () => runWarmupGate());
      }
      // Stop recurring tests whose campaign stopped being active since the scan
      let reconcileResult: unknown = null;
      if (config.enableTestReconciler) {
        reconcileResult = await stage("test-reconcile", () => runTestReconcile());
      }
      // Zone-level faults are invisible from inside Smartlead; resolve DNS
      // directly so a domain sending without SPF cannot stay silent.
      const dnsAuditResult: unknown = await stage("dns-audit", () => dnsAudit.run());
      // Campaign-level audit (read-only). Staffing mutations live on the
      // faster CRON_HEALTH loop so thin campaigns do not wait six hours.
      const campaignAuditResult: unknown = await stage("campaign-audit", () =>
        campaignAudit.run(),
      );
      // D52 — remaining leads. Campaign audit watches senders, not this number.
      let leadRunoutResult: unknown = null;
      if (config.enableLeadRunout) {
        leadRunoutResult = await stage("lead-runout", () => leadRunout.run());
      }
      // D53 — sending IPs from placement reports we already pull.
      let sendingInfraResult: unknown = null;
      if (config.enableSendingInfraCensus) {
        sendingInfraResult = await stage("sending-infra", () => sendingInfra.run());
      }
      let podControlResult: unknown = null;
      if (config.enablePodControls) {
        podControlResult = await stage("pod-controls", () => podControls.run());
        await stage("domain-client-audit", () => domainClientAudit.run());
      await stage("domain-lifecycle", () => domainLifecycle.run());
        await stage("isolation-buy-resume", () => isolationBuy.resume());
        await stage("canary-buy-resume", () => copyCanaryBuy.resume());
        await stage("canary-adopt", () => runCanaryAdoption());
      }
      let isolationRigResult: unknown = null;
      if (config.enableIsolationRig) {
        isolationRigResult = await stage("isolation-rig", () => isolationRig.run());
      }
      let isolationBranchResult: unknown = null;
      if (config.enableIsolationBranch) {
        isolationBranchResult = await stage("isolation-branch", () => isolationBranch.run());
      }
      if (config.enableCopyIsolation) {
        await stage("copy-isolation", async () => {
          for (const run of state.listIsolationRuns()) {
            if (!run.teardownStarted) continue;
            await copyIsolation.runForCampaign(run);
          }
        });
      }
      return {
        monitor: monitorResult,
        warmupGate: warmupGateResult,
        testReconcile: reconcileResult,
        dnsAudit: dnsAuditResult,
        campaignAudit: campaignAuditResult,
        leadRunout: leadRunoutResult,
        sendingInfra: sendingInfraResult,
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
  if (!cron.validate(config.cronCampaignCheck)) {
    throw new Error(
      `Invalid CRON_CAMPAIGN_CHECK expression: ${config.cronCampaignCheck}`,
    );
  }
  if (!cron.validate(config.cronBounceAutostop)) {
    throw new Error(
      `Invalid CRON_BOUNCE_AUTOSTOP expression: ${config.cronBounceAutostop}`,
    );
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
  sendVolumeSchedules.forEach((expression, index) => {
    const endOfDay = index === sendVolumeSchedules.length - 1;
    cron.schedule(
      expression,
      () => {
        void clientDayBrief.run({ endOfDay }).catch((error) => {
          console.error("[client-day] Unhandled cron error", error);
        });
      },
      { timezone: "America/New_York" },
    );
  });

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

  if (config.enableCampaignCheck) {
    cron.schedule(config.cronCampaignCheck, () => {
      if (healthInFlight) {
        console.log(
          "[campaign-check] Health pass running — skipping overlapping hourly sweep",
        );
        return;
      }
      void inventoryBook
        .get()
        .then((inventory) => campaignCheck.run({ mode: "hourly", inventory }))
        .catch((error) => {
          console.error("[campaign-check] Unhandled cron error", error);
          feedBugRemediator("campaign-check-cron", error);
        });
    });
  }

  if (config.enableCampaignHealth) {
    cron.schedule(config.cronHealth, () => {
      void runHealth().catch((error) => {
        console.error("[health] Unhandled cron error", error);
        feedBugRemediator("health-cron", error);
      });
    });
    // D122 — no boot health. D89 staggered it three minutes after
    // listen; attach (90s) plus that kick still 429'd inventory
    // (live 2026-08-26 D121: attach ended 06:35:31, boot health
    // skipped 06:36:01). The 15-minute cron is soon enough.
  }

  if (config.enableCampaignBounceAutostop) {
    cron.schedule(config.cronBounceAutostop, () => {
      void runBounceAutostop().catch((error) => {
        console.error("[bounce-autostop] Unhandled cron error", error);
        feedBugRemediator("bounce-autostop-cron", error);
      });
    });
    // No boot kick — the 10-minute cron is soon enough. The first
    // minutes after deploy belong to canary attach (D122).
  }

  if (config.enablePoolProvisioner) {
    cron.schedule(config.cronPoolProvision, () => {
      void runPoolProvision().catch((error) => {
        console.error("[pool-provision] Unhandled cron error", error);
      });
    });
    // D122 — no boot pool. The eight-minute kick (06:41–06:43)
    // starved the 06:45 health cron. CRON_POOL_PROVISION every
    // 30 minutes is enough.
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
    // No boot kick — health already reconnects on the 15-minute pass.
  }

  // D86 — a canary fleet Josh bought by hand in InboxKit is adopted, not
  // stranded. Kick shortly after boot (a deploy restarts the app, so this
  // runs within ~2 minutes of merging) and again on each monitor pass while
  // the fleet is not ready. Slack only when something was actually adopted
  // or adoption needs a human; "nothing found" stays in logs.
  const runCanaryAdoption = async (): Promise<void> => {
    const result = await copyCanaryBuy.adoptManualPurchase();
    if (!result) {
      console.log("[copy-canary-adopt] fleet is healthy — nothing to adopt");
    } else if (result.adopted.length && result.changed) {
      await slack.send(
        [
          `Found the ${result.adopted.length} unwarmed inbox${result.adopted.length === 1 ? "" : "es"} you bought and registered them as the copy-test canaries:`,
          ...result.adopted.map((email) => `• ${email}`),
          "Warmup is off and they will never staff a live campaign.",
          result.ready
            ? "They are in Smartlead — campaign copy tests start on this pass."
            : "Smartlead is still importing them; I keep checking and the copy tests start as soon as they land.",
        ].join("\n"),
        undefined,
        "action_result",
      );
    } else if (result.reason?.includes("too many")) {
      await slack.send(
        `I looked for the unwarmed inboxes you bought but ${result.reason}. Tell me the domain and I will register them.`,
        undefined,
        "action_result",
      );
    } else if (result.reason) {
      console.log(`[copy-canary-adopt] nothing adopted: ${result.reason}`);
    }

    // D89 — attach campaign-copy tests here, not only inside health. A
    // 429'd inventory stage used to leave a ready fleet with no tests.
    if (state.getCopyCanaryFleet()?.emails.length) {
      const attach = await copyCanary.attach();
      console.log(
        `[copy-canary] attach tests=${attach.testsEnsured} errors=${attach.errors.length} skipped=${attach.skipped.join(";") || "none"}`,
      );
      for (const err of attach.errors.slice(0, 12)) {
        console.warn(`[copy-canary] ${err}`);
      }
      if (attach.errors.length > 12) {
        console.warn(`[copy-canary] … and ${attach.errors.length - 12} more`);
      }
    }
  };
  if (secretsReady) {
    setTimeout(() => {
      void runCanaryAdoption().catch((error) => {
        console.warn("[copy-canary-adopt] boot kick failed", error);
      });
    }, 90_000);
  }

  // Old Slack buttons were posted by another bot, so taps never arrived.
  // Re-send pending asks with signed /slack/action links after deploy.
  // D97 — leftover Add %signature% asks are dismissed, not re-posted.
  setTimeout(() => {
    const dropped = dismissPendingSignatureAsks(state);
    if (dropped) {
      console.log(
        `[slack] Dismissed ${dropped} leftover signature ask(s) (D97)`,
      );
      void state.save().catch((error) => {
        console.error("[slack] could not persist signature-ask dismiss", error);
      });
    }
    void remindPendingIsolationActions({ store: state, slack })
      .then((count) => {
        if (count) {
          console.log(`[slack] Re-posted ${count} pending isolation button(s)`);
        }
      })
      .catch((error) => {
        console.error("[slack] isolation remind failed", error);
      });
  }, 25_000);

  const app = express();
  // Railway terminates TLS one proxy hop in front of the app. This makes
  // req.ip useful for login throttling without trusting arbitrary forwarded
  // chains.
  app.set("trust proxy", 1);

  const escapeHtml = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const slackActionHtml = (opts: {
    title: string;
    body: string;
    form?: { id: string; decision: string; exp: string; sig: string };
    /** D153 — optional custom swap on the confirm page for swap_copy. */
    swapEdit?: { element: string; suggested: string };
  }): string => {
    const swapFields =
      opts.form && opts.swapEdit && opts.form.decision === "approve"
        ? `<p style="margin:1rem 0 .4rem;color:#94a3b8;font-size:.85rem;"><strong>Replacing this exact phrase/word:</strong></p>
<pre style="white-space:pre-wrap;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:.75rem;color:#e2e8f0;font-size:.85rem;">${escapeHtml(opts.swapEdit.element)}</pre>
<label style="display:block;margin:1rem 0 .4rem;color:#94a3b8;font-size:.85rem;">Replace it with (edit freely — blank deletes the phrase)</label>
<textarea name="swap" rows="4" style="width:100%;box-sizing:border-box;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:.75rem;font:inherit;">${escapeHtml(opts.swapEdit.suggested)}</textarea>`
        : "";
    const form = opts.form
      ? `<form method="post" action="/slack/action">
<input type="hidden" name="id" value="${escapeHtml(opts.form.id)}" />
<input type="hidden" name="decision" value="${escapeHtml(opts.form.decision)}" />
<input type="hidden" name="exp" value="${escapeHtml(opts.form.exp)}" />
<input type="hidden" name="sig" value="${escapeHtml(opts.form.sig)}" />
<input type="hidden" name="confirm" value="1" />
${swapFields}
<button type="submit">${opts.form.decision === "approve" ? (opts.swapEdit ? "Apply this edit" : "Confirm") : "Confirm deny"}</button>
</form>`
      : "";
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:2rem;}
main{max-width:36rem;margin:0 auto;background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.5rem;}
h1{font-size:1.25rem;margin:0 0 .75rem;}
p{line-height:1.5;color:#cbd5e1;white-space:pre-wrap;}
button{background:#38bdf8;color:#0f172a;border:0;border-radius:8px;padding:.7rem 1.1rem;font-weight:700;cursor:pointer;margin-top:1rem;}
</style></head><body><main><h1>${escapeHtml(opts.title)}</h1><p>${escapeHtml(opts.body)}</p>${form}</main></body></html>`;
  };

  const isolationKindTitle = (kind: string): string => {
    if (kind === "buy_canary_fleet") return "Buy canary fleet";
    if (kind === "buy_isolation_domain") return "Buy it and arm the rig";
    if (kind === "buy_domains") return "Buy replacements";
    if (kind === "retire_domain") return "Retire this domain";
    if (kind === "swap_copy") return "Edit the copy";
    if (kind === "generic_backfill") return "Allow generics";
    if (kind === "add_signature_tag") return "Add %signature%";
    return kind;
  };

  const readSignedSlackAction = (src: Record<string, unknown>) => {
    const id = typeof src.id === "string" ? src.id : "";
    const decision = typeof src.decision === "string" ? src.decision : "";
    const exp = typeof src.exp === "string" ? src.exp : "";
    const sig = typeof src.sig === "string" ? src.sig : "";
    const verified = verifySlackActionLink({
      secret: config.slackSigningSecret,
      id,
      decision,
      exp,
      sig,
    });
    if (!verified.ok) return { ok: false as const, reason: verified.reason };
    return {
      ok: true as const,
      id,
      decision: verified.decision,
      exp,
      sig,
    };
  };

  app.get("/slack/install", (_req, res) => {
    if (!config.slackClientId) {
      res
        .status(503)
        .type("html")
        .send(
          slackActionHtml({
            title: "Slack install not configured",
            body: "SLACK_CLIENT_ID is missing. Add the Wizard Slack app credentials and retry.",
          }),
        );
      return;
    }
    res.redirect(
      302,
      slackInstallHref({
        clientId: config.slackClientId,
        redirectUri: config.slackOauthRedirectUri,
      }),
    );
  });

  app.get("/slack/action", (req, res) => {
    const parsed = readSignedSlackAction(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      res
        .status(400)
        .type("html")
        .send(
          slackActionHtml({
            title: "Link expired or invalid",
            body: `${parsed.reason} Ask the Wizard to send a fresh Slack message, or use /ops Isolation.`,
          }),
        );
      return;
    }
    const pending = state.getIsolationAction(parsed.id);
    const title = isolationKindTitle(pending?.kind ?? "request");
    if (!pending || pending.status !== "pending") {
      res.type("html").send(
        slackActionHtml({
          title,
          body: pending
            ? `This request is already ${pending.status}.`
            : "That request is no longer pending.",
        }),
      );
      return;
    }
    const spendNote =
      pending.kind === "buy_canary_fleet" || pending.kind === "buy_domains"
        ? " Confirming spends real money."
        : "";
    const verb =
      parsed.decision === "approve"
        ? `This will ${title.toLowerCase()} now.${spendNote}`
        : "This will deny the request. Nothing will be bought or retired.";
    const swapEdit =
      pending.kind === "swap_copy" && parsed.decision === "approve"
        ? {
            element: String(pending.detail.element ?? ""),
            suggested: String(pending.detail.swap ?? ""),
          }
        : undefined;
    res.type("html").send(
      slackActionHtml({
        title: pending.title || title,
        body: [pending.proof, verb].filter(Boolean).join("\n\n"),
        form: parsed,
        swapEdit:
          swapEdit && swapEdit.element
            ? swapEdit
            : undefined,
      }),
    );
  });

  app.post(
    "/slack/action",
    express.urlencoded({ extended: false }),
    async (req, res) => {
      const parsed = readSignedSlackAction(
        (req.body ?? {}) as Record<string, unknown>,
      );
      if (!parsed.ok || req.body?.confirm !== "1") {
        res
          .status(400)
          .type("html")
          .send(
            slackActionHtml({
              title: "Link expired or invalid",
              body: `${!parsed.ok ? parsed.reason : "Confirm the form first."} Ask the Wizard to send a fresh Slack message, or use /ops Isolation.`,
            }),
          );
        return;
      }
      try {
        const pending = state.getIsolationAction(parsed.id);
        if (
          pending &&
          pending.kind === "swap_copy" &&
          pending.status === "pending" &&
          parsed.decision === "approve" &&
          typeof req.body?.swap === "string"
        ) {
          const swap = String(req.body.swap);
          state.upsertIsolationAction({
            ...pending,
            detail: { ...pending.detail, swap },
            proof: copySwapProof({
              campaignName: String(
                pending.detail.campaignName ?? pending.title,
              ),
              element: String(pending.detail.element ?? ""),
              swap,
              controlLanded: true,
            }),
          });
        }
        const result = await isolationExecute.decide(
          parsed.id,
          parsed.decision,
          { name: "Josh", role: "owner" },
        );
        res
          .status(result.ok ? 200 : 409)
          .type("html")
          .send(
            slackActionHtml({
              title: result.ok ? "Done" : "Could not complete",
              body: result.message,
            }),
          );
      } catch (error) {
        res
          .status(500)
          .type("html")
          .send(
            slackActionHtml({
              title: "Failed",
              body: error instanceof Error ? error.message : String(error),
            }),
          );
      }
    },
  );

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
          console.warn("[slack-interactions] bad signature");
          res.status(401).json({ error: "Bad Slack signature" });
          return;
        }
        const payloadRaw = new URLSearchParams(rawBody).get("payload");
        if (!payloadRaw) {
          res.status(400).json({ error: "Missing payload" });
          return;
        }
        const payload = JSON.parse(payloadRaw) as {
          type?: string;
          trigger_id?: string;
          user?: { id?: string; name?: string; username?: string };
          actions?: Array<{ action_id?: string; value?: string }>;
          view?: {
            callback_id?: string;
            private_metadata?: string;
            state?: {
              values?: Record<
                string,
                Record<string, { value?: string | null } | undefined> | undefined
              >;
            };
          };
          response_url?: string;
        };

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

        // D153 — modal submit: stamp Josh's swap onto the pending ask, then approve.
        if (payload.type === "view_submission") {
          if (payload.view?.callback_id !== SWAP_EDIT_CALLBACK_ID) {
            res.status(200).json({ text: "That form is not one I handle." });
            return;
          }
          const actionId = String(payload.view.private_metadata ?? "").trim();
          const pending = state.getIsolationAction(actionId);
          if (!pending || pending.kind !== "swap_copy" || pending.status !== "pending") {
            res.status(200).json({
              response_action: "errors",
              errors: {
                [SWAP_EDIT_INPUT_BLOCK_ID]:
                  "That copy-edit ask is no longer pending. Ask the Wizard to re-post it.",
              },
            });
            return;
          }
          if (role !== "owner" && role !== "operator") {
            res.status(200).json({
              response_action: "errors",
              errors: {
                [SWAP_EDIT_INPUT_BLOCK_ID]:
                  "Only Josh or Cayden can apply a copy edit from Slack.",
              },
            });
            return;
          }
          const swap = swapTextFromViewSubmission(payload.view);
          const element = String(pending.detail.element ?? "");
          const campaignName = String(
            pending.detail.campaignName ?? pending.title,
          );
          state.upsertIsolationAction({
            ...pending,
            detail: { ...pending.detail, swap },
            proof: copySwapProof({
              campaignName,
              element,
              swap,
              controlLanded: true,
            }),
          });
          // Ack the modal closed immediately; apply async (D133 can take >3s).
          res.status(200).json({ response_action: "clear" });
          void isolationExecute
            .decide(actionId, "approve", { name, role })
            .then(async (result) => {
              await slack.notifyActionResult(result.message);
            })
            .catch((error) => {
              console.error("[slack-interactions] swap edit apply failed", error);
            });
          return;
        }

        if (payload.type && payload.type !== "block_actions") {
          res.status(200).json({ text: "That interaction is not one I handle." });
          return;
        }

        const parsed = parseIsolationActionValue(
          payload.actions?.[0]?.value ?? "",
        );
        if (!parsed) {
          res.status(200).json({ text: "That button is not one I handle." });
          return;
        }
        console.log(
          `[slack-interactions] kind=${parsed.kind} decision=${parsed.decision} role=${role}`,
        );

        // D153 — open the Write my own edit modal (must use trigger_id <3s).
        if (parsed.decision === "edit") {
          if (parsed.kind !== "swap_copy") {
            res.status(200).json({ text: "Custom edit is only for copy swaps." });
            return;
          }
          if (role !== "owner" && role !== "operator") {
            res.status(200).json({
              text: "Only Josh or Cayden can write a custom copy edit.",
            });
            return;
          }
          const pending = state.getIsolationAction(parsed.id);
          if (!pending || pending.kind !== "swap_copy" || pending.status !== "pending") {
            res.status(200).json({
              text: "That copy-edit ask is no longer pending.",
            });
            return;
          }
          const element = String(pending.detail.element ?? "").trim();
          if (!element) {
            res.status(200).json({
              text: "That ask is missing the phrase to replace — re-run the word hunt.",
            });
            return;
          }
          if (!payload.trigger_id) {
            res.status(200).json({
              text: "Slack did not send a trigger_id — try again from the button.",
            });
            return;
          }
          const opened = await slack.openSwapEditModal({
            triggerId: payload.trigger_id,
            actionId: pending.id,
            element,
            suggestedSwap: String(pending.detail.swap ?? ""),
            campaignName:
              typeof pending.detail.campaignName === "string"
                ? pending.detail.campaignName
                : undefined,
          });
          if (!opened.ok) {
            console.warn("[slack-interactions] views.open failed", opened.error);
            res.status(200).json({
              text: `Could not open the edit form (${opened.error ?? "unknown"}). Check the Wizard Slack app has views.open, or use /ops.`,
            });
            return;
          }
          res.status(200).send();
          return;
        }

        if (
          (role === "unknown" || role === "operator") &&
          (parsed.kind === "buy_domains" ||
            parsed.kind === "buy_canary_fleet" ||
            parsed.kind === "retire_domain")
        ) {
          res.status(200).json({
            text:
              role === "operator"
                ? "Only Josh can approve a purchase or a retire. The confirm page is the same rule."
                : "I do not recognize this Slack user as Josh. Approve in Railway → /ops.",
          });
          return;
        }
        if (parsed.decision !== "approve" && parsed.decision !== "deny") {
          res.status(200).json({ text: "That button is not one I handle." });
          return;
        }
        // Slack requires an answer in 3s. Buying domains takes longer, so
        // ack now and post the result to response_url / the channel.
        res.status(200).json({
          text: "Working on it — I will post here when it is done.",
        });
        void isolationExecute
          .decide(parsed.id, parsed.decision, { name, role })
          .then(async (result) => {
            const text = result.message;
            if (payload.response_url) {
              await fetch(payload.response_url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text }),
              });
              return;
            }
            await slack.notifyActionResult(text);
          })
          .catch((error) => {
            console.error("[slack-interactions] decide failed", error);
          });
      } catch (error) {
        console.error("[slack-interactions]", error);
        if (!res.headersSent) {
          res.status(200).json({
            text: error instanceof Error ? error.message : "That tap failed.",
          });
        }
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
      cursorAssistant,
      isolationExecute,
      runtime: {
        deliverability: runOpsDeliverability,
        dns: () => dnsAudit.run({ alert: false }),
        campaigns: () => campaignAudit.run(),
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

  // YouTube / restore demo: DW-styled campaign archive + redacted reply
  // inbox. Prospect emails and offer terms are already masked in
  // public/demo/data.json — served publicly so Josh has a clickable URL.
  const demoPublicDir = path.resolve(__dirname, "../public/demo");
  app.use(
    "/demo",
    express.static(demoPublicDir, {
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
    // D84 — the canon scoreboard: open findings by kind (living campaigns
    // only) and per-stage watchdog, so "is the sweep actually running" is a
    // curl instead of a Smartlead eyeball.
    const canonFindings: Record<string, number> = {};
    const canonFindingSamples: Record<string, string[]> = {};
    for (const record of Object.values(s.campaignChecks ?? {})) {
      for (const finding of record.findings ?? []) {
        const kind = finding.split(":")[0] ?? "unknown";
        canonFindings[kind] = (canonFindings[kind] ?? 0) + 1;
        const samples = canonFindingSamples[kind] ?? [];
        if (samples.length < 5) {
          samples.push(`#${record.campaignId} ${record.name}`);
          canonFindingSamples[kind] = samples;
        }
      }
    }
    const board = canonBoard(Object.values(s.campaignChecks ?? {}));
    const stages: Record<
      string,
      { lastOkAt: string | null; consecutiveFailures: number; lastError: string | null }
    > = {};
    for (const [name, row] of Object.entries(s.stageHealth ?? {})) {
      stages[name] = {
        lastOkAt: row.lastOkAt,
        consecutiveFailures: row.consecutiveFailures,
        lastError: row.consecutiveFailures > 0 ? row.lastError : null,
      };
    }
    res.json({
      ok: true,
      service: "deliverabilitywizard",
      canonFindings,
      canonFindingSamples,
      canonCompliant: board.compliant,
      canonYes: board.campaigns.filter((row) => row.yes).length,
      canonNo: board.campaigns.filter((row) => !row.yes).length,
      canaryFleetDown: s.canaryFleetDown ?? null,
      stages,
      deploy: deployIdentity,
      secretsConfigured: secretsReady,
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
      enableCampaignCheck: config.enableCampaignCheck,
      cronCampaignCheck: config.cronCampaignCheck,
      campaignCheckCount: Object.keys(s.campaignChecks ?? {}).length,
      enableCampaignBounceAutostop: config.enableCampaignBounceAutostop,
      cronBounceAutostop: config.cronBounceAutostop,
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
      poolWarmupDays: config.poolWarmupDays,
      enableWarmupGate: config.enableWarmupGate,
      campaignMinWarmupDays: config.campaignMinWarmupDays,
      enablePoolProvisioner: config.enablePoolProvisioner,
      poolProvisionPhase: s.poolProvision?.phase ?? "idle",
      poolMailboxCount: Object.keys(s.poolMailboxes).length,
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
        cronCampaignCheck: config.cronCampaignCheck,
        enableCampaignCheck: config.enableCampaignCheck,
        enableCampaignHealth: config.enableCampaignHealth,
        enableCampaignBounceAutostop: config.enableCampaignBounceAutostop,
        cronBounceAutostop: config.cronBounceAutostop,
        enableClientRest: config.enableClientRest,
        enableGenericSendRest: config.enableGenericSendRest,
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
        enablePoolProvisioner: config.enablePoolProvisioner,
        enableAccountReconnect: config.enableAccountReconnect,
        enableWarmupGate: config.enableWarmupGate,
        enableCopyCanary: config.enableCopyCanary,
        copyCanaryPerCampaign: config.copyCanaryPerCampaign,
        enableLeadRunout: config.enableLeadRunout,
        enableSendingInfraCensus: config.enableSendingInfraCensus,
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
        const result = await campaignAudit.run();
        res.json({ ok: true, mode: "campaign-audit", result });
        return;
      }
      if (mode === "campaign-check" || mode === "new-campaign-check") {
        assertRuntimeSecrets(config);
        const result = await campaignCheck.run({ mode: "all" });
        res.json({ ok: true, mode: "campaign-check", result });
        return;
      }
      if (mode === "one-client" || mode === "one-client-membership") {
        assertRuntimeSecrets(config);
        const result = await oneClientMembership.run();
        res.json({ ok: true, mode: "one-client", result });
        return;
      }
      if (mode === "client-tag" || mode === "campaign-client-tag") {
        assertRuntimeSecrets(config);
        const result = await campaignClientTag.run();
        res.json({ ok: true, mode: "client-tag", result });
        return;
      }
      if (mode === "qa-unpause" || mode === "unpause-after-sig-qa") {
        assertRuntimeSecrets(config);
        const result = await unpauseAfterSigQa.run();
        res.json({ ok: true, mode: "qa-unpause", result });
        return;
      }
      if (mode === "bounce-autostop" || mode === "bounce-autopause" || mode === "bounce-threshold") {
        assertRuntimeSecrets(config);
        // D85 — one bounce loop. The old aliases run the same autostop;
        // there is no Smartlead autopause write to trigger (D157).
        const result = await runBounceAutostop();
        res.json({ ok: true, mode: "bounce-autostop", result });
        return;
      }
      if (mode === "fan-out" || mode === "client-fanout") {
        assertRuntimeSecrets(config);
        if (healthInFlight || topUpInFlight) {
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
      if (mode === "client-rest" || mode === "rest") {
        assertRuntimeSecrets(config);
        const result = await clientRest.run();
        res.json({ ok: true, mode: "client-rest", result });
        return;
      }
      if (mode === "client-day" || mode === "send-volume" || mode === "day-brief") {
        assertRuntimeSecrets(config);
        const result = await clientDayBrief.run({ endOfDay: true });
        res.json({ ok: true, mode: "client-day", result });
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
      if (mode === "isolation-remind" || mode === "remind-isolation") {
        const count = await remindPendingIsolationActions({ store: state, slack });
        res.json({ ok: true, mode: "isolation-remind", result: { count } });
        return;
      }
      if (mode === "copy-canary-resume" || mode === "canary-resume") {
        const finished = await copyCanaryBuy.resume();
        res.json({ ok: true, mode: "copy-canary-resume", result: { finished } });
        return;
      }
      if (mode === "delivery-watch" || mode === "copy-watch") {
        assertRuntimeSecrets(config);
        const result = await deliveryWatch.run();
        res.json({ ok: true, mode: "delivery-watch", result });
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
    console.log(
      `[boot] Deploy identity (D149): ${deployIdentityLine(deployIdentity)}`,
    );
    {
      const identityProblem = deployIdentityProblem(deployIdentity);
      if (identityProblem) {
        console.error(`[watchdog] deploy identity: ${identityProblem}`);
        if (secretsReady && !config.dryRun) {
          void slack
            .send(
              `:rotating_light: Deploy identity (D149): ${identityProblem}. If nobody deployed this on purpose, the stale-snapshot redeployer is back — check the Railway activity log and point the service back at main.`,
              undefined,
              "ops_alert",
            )
            .catch((error) =>
              console.warn("[watchdog] deploy identity page failed", error),
            );
        }
      }
    }
    console.log(`[boot] Scan cron: ${config.cronScan}`);
    // D122 — no boot campaign-audit. It lists campaigns + accounts +
    // tests + sequences and raced attach (06:32:49–06:36:41 vs attach
    // 06:34–06:35). Read-only audit stays on the 6-hour monitor.
    if (secretsReady) {
    }
    console.log(
      `[boot] Placement tests: ${config.autoPlacementTests ? `RECURRING every ${config.placementTestEveryDays}d while campaign in [${config.autoTestActiveStatuses.join(",")}]` : "one-off manual"}${config.enableTestReconciler ? " (auto-stop on inactive)" : ""}`,
    );
    console.log(`[boot] Monitor cron: ${config.cronMonitor} (measure/remediate/DNS)`);
    console.log(
      `[boot] Campaign health: ${config.enableCampaignHealth ? `ENABLED (${config.cronHealth}; D58 half-client-inbox floor; auto-resume protective pauses)` : "disabled"}`,
    );
    console.log(
      `[boot] Campaign check (D81): ${config.enableCampaignCheck ? `ENABLED first-seen on health; hourly sweep ${config.cronCampaignCheck}` : "disabled"}`,
    );
    console.log(
      `[boot] Campaign bounce loop (D141/D148): ${config.enableCampaignBounceAutostop ? `ENABLED (${config.cronBounceAutostop}; burst >${config.bounceBurstCount} bounces/10m from sends <24h old → classify + re-queue, never pause; ledger dumps do nothing; Smartlead bounce protection is UI-only, no API off-switch exists (D157))` : "disabled"}`,
    );
    console.log(
      `[boot] Sender rest (D43): ${config.enableClientRest ? "ENABLED (per-client A/B, 2 weeks on / 2 weeks off)" : "disabled"}; generics ${config.enableGenericSendRest ? `sit after ${config.genericSendRestDays}d live send` : "no send-clock"}`,
    );
    console.log(
      `[boot] Mailbox settings: ${config.enforceMailboxSettings ? `ENFORCED (${config.messagePerDay}/day warmups-not-included, ${config.mailboxMinTimeGapMins}m min gap every health pass; signatures/warmup every 6h)` : "not enforced"}`,
    );
    console.log(
      `[boot] Campaign top-up: ${config.enableCampaignTopUp ? `ENABLED via health (half-client-inbox floor; generics on POC ${config.pocClientNamePatterns.join("/") || "nobody"} or Slack approve${config.topUpExcludeCampaigns.length ? `; excluding ${config.topUpExcludeCampaigns.join(", ")}` : ""})` : "disabled"}`,
    );
    console.log(
      `[boot] Pool provisioner: ${config.enablePoolProvisioner ? `ENABLED (${config.cronPoolProvision})` : "disabled"} phase=${state.get().poolProvision.phase}`,
    );
    console.log(
      `[boot] Account reconnect: ${config.enableAccountReconnect ? `ENABLED (${config.cronAccountReconnect} America/New_York)` : "disabled"}`,
    );
    console.log(
      `[boot] Warmup gate: ${config.enableWarmupGate ? `ENABLED (min ${config.campaignMinWarmupDays}d from InboxKit; canary/pre-warmed exempt; every health pass)` : "disabled"}`,
    );
    console.log(
      `[boot] Live mailbox pull: KILL-ONLY (domain retire + 21-day gate + backfill; D51/D105/D130)`,
    );
    console.log(
      `[boot] Copy canaries: ${config.enableCopyCanary ? "ENABLED (dedicated 2-domain fleet, warmup off, off-campaign copy tests)" : "disabled"}`,
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
      "[boot] Slack (D71/D149): burned-domain replace, isolated-word replace, EOD sends/spam, ops alerts (stage watchdog + deploy identity)",
    );
    console.log(
      `[boot] Lead runout: ${config.enableLeadRunout ? "ENABLED (half / three-quarters / done, logs only, no import)" : "disabled"}`,
    );
    console.log(
      `[boot] Sending infra census: ${config.enableSendingInfraCensus ? "ENABLED (placement-report IPs, logs only)" : "disabled"}`,
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
