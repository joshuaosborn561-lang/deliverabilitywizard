import { randomUUID } from "node:crypto";
import express from "express";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { OpsAuth, OpsRole, OpsSession } from "./auth.js";
import { campaignSetupPrompt } from "./campaignSetupPrompt.js";
import { classifyOpsMessage, opsHelp } from "./policy.js";
import type { CursorAssistantService } from "./cursorAssistant.js";
import type {
  ManualRotationService,
  RotationResult,
} from "./manualRotation.js";
import type { IsolationExecuteService } from "../services/isolationExecute.js";
import { canDecideIsolationAction } from "../lib/isolationActors.js";

export interface OpsRuntime {
  deliverability: () => Promise<{
    monitor: unknown;
    dns: unknown;
    campaigns: unknown;
  }>;
  dns: () => Promise<unknown>;
  campaigns: () => Promise<unknown>;
  reconnect: () => Promise<unknown>;
  placements: (force?: boolean) => Promise<unknown>;
  fleet: (force?: boolean) => Promise<unknown>;
}

interface AuthenticatedRequest extends express.Request {
  opsSession?: OpsSession;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOpsRouter(opts: {
  config: AppConfig;
  auth: OpsAuth;
  state: StateStore;
  rotation: ManualRotationService;
  executeRotation: (email: string) => Promise<RotationResult>;
  runtime: OpsRuntime;
  cursorAssistant?: CursorAssistantService | null;
  isolationExecute?: IsolationExecuteService;
}): express.Router {
  const router = express.Router();
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const actionLocks = new Set<string>();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  const audit = async (
    session: OpsSession,
    action: string,
    outcome: "success" | "denied" | "error",
    target?: string,
    detail?: string,
    required = false,
  ) => {
    try {
      opts.state.appendOpsAudit({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: session.username,
        role: session.role,
        action,
        target,
        outcome,
        detail: detail?.slice(0, 500),
      });
      await opts.state.save();
    } catch (error) {
      console.error("[ops] Failed to persist audit record", error);
      if (required) {
        throw new Error(
          "Operation blocked because the audit log is not writable",
        );
      }
    }
  };

  const requireSession = (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const session = opts.auth.sessionFromCookie(req.header("cookie"));
    if (!session) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    req.opsSession = session;
    next();
  };

  const requireCsrf = (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }
    const supplied = req.header("x-csrf-token") || "";
    if (!req.opsSession || supplied !== req.opsSession.csrf) {
      res.status(403).json({ error: "Invalid CSRF token" });
      return;
    }
    next();
  };

  const requireOwner = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.opsSession?.role !== "owner") {
      if (req.opsSession) {
        await audit(
          req.opsSession,
          "owner-only",
          "denied",
          req.path,
          "Only Josh can approve or deny spend.",
        );
      }
      res.status(403).json({
        error: "Only Josh can approve or deny spend.",
      });
      return;
    }
    next();
  };

  router.get("/config", (_req, res) => {
    res.json({
      enabled: opts.config.opsUiEnabled,
      configured: opts.auth.isConfigured(),
      error: opts.auth.configurationError(),
    });
  });

  router.post("/login", async (req, res) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    const bucket = loginAttempts.get(key);
    if (bucket && bucket.resetAt > now && bucket.count >= 5) {
      res.status(429).json({ error: "Too many login attempts. Try later." });
      return;
    }
    const username = String(req.body?.username ?? "");
    const accessKey = String(req.body?.accessKey ?? "");
    const session = opts.auth.authenticate(username, accessKey);
    if (!session) {
      loginAttempts.set(key, {
        count: bucket && bucket.resetAt > now ? bucket.count + 1 : 1,
        resetAt: now + 15 * 60 * 1000,
      });
      res.status(401).json({ error: "Invalid username or access key" });
      return;
    }
    loginAttempts.delete(key);
    res.setHeader("Set-Cookie", opts.auth.cookie(session));
    await audit(session, "login", "success");
    res.json({
      user: { username: session.username, role: session.role },
      csrf: session.csrf,
    });
  });

  router.use(requireSession, requireCsrf);

  router.get("/session", (req: AuthenticatedRequest, res) => {
    const session = req.opsSession!;
    res.json({
      user: { username: session.username, role: session.role },
      csrf: session.csrf,
      expiresAt: session.expiresAt,
    });
  });

  router.post("/logout", (req: AuthenticatedRequest, res) => {
    res.setHeader("Set-Cookie", opts.auth.clearCookie());
    res.json({ ok: true });
  });

  router.get("/dashboard", async (req: AuthenticatedRequest, res) => {
    try {
      const state = opts.state.get();
      const pool = Object.values(state.poolMailboxes);
      const poolByStatus = pool.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {});
      const pendingApprovals = Object.values(state.spendApprovals).filter(
        (approval) => approval.status === "pending",
      ).length;
      let fleet: unknown;
      let fleetError: string | undefined;
      try {
        fleet = await opts.runtime.fleet(
          String(req.query.force ?? "") === "1",
        );
        if (
          fleet &&
          typeof fleet === "object" &&
          typeof (fleet as { error?: unknown }).error === "string"
        ) {
          fleetError = (fleet as { error: string }).error;
        }
      } catch (error) {
        fleetError = safeMessage(error);
        // Local state remains useful during a transient Smartlead outage.
        fleet = {
          generatedAt: new Date().toISOString(),
          totalMailboxes: null,
          sendingMailboxes: null,
          mailboxesInRecovery: Object.keys(state.heldInboxes).length,
          activeCampaigns: null,
          disconnectedMailboxes: null,
          stale: true,
        };
      }
      res.json({
        user: {
          username: req.opsSession!.username,
          role: req.opsSession!.role,
        },
        lastRuns: {
          scan: state.lastScanAt,
          monitor: state.lastMonitorAt,
          remediation: state.lastRemediationAt,
          reconnect: state.lastReconnectAt,
          warmupGate: state.lastWarmupGateAt,
          health: state.lastHealthAt,
        },
        fleet,
        fleetError,
        pool: {
          total: pool.length,
          byStatus: poolByStatus,
          activeSwaps: Object.keys(state.activeSwaps).length,
          heldInboxes: Object.keys(state.heldInboxes).length,
          restingInboxes: Object.keys(state.restingInboxes ?? {}).length,
          phase: state.poolProvision.phase,
          message: state.poolProvision.lastMessage,
        },
        policy: {
          campaignSenderFloor: "half that client's inboxes",
          mailboxDailyCap: opts.config.messagePerDay,
          warmupDays: opts.config.poolWarmupDays,
          freshInboxWarmupDays: opts.config.freshInboxWarmupDays,
          recoveryHoldDays: opts.config.recoveryHoldDays,
          inboxThreshold: opts.config.remediationInboxThreshold,
          bounceThreshold: opts.config.bounceRateThreshold,
          bounceWarnThreshold: opts.config.bounceRateWarnThreshold,
          bounceMinSample: opts.config.minBounceSample,
          bounceAutostop: opts.config.enableCampaignBounceAutostop
            ? `${opts.config.bounceAutostopMidPercent}% after ${opts.config.bounceAutostopMinSent} / ${opts.config.bounceAutostopHighPercent}% after ${opts.config.bounceAutostopHighVolumeSent}`
            : "off",
          clientRest: opts.config.enableClientRest,
          genericSendRestDays: opts.config.genericSendRestDays,
          espMixMinPercent: opts.config.campaignEspMixMinPercent,
          restBaselineRebuild: opts.config.enableRestBaselineRebuild,
          restBaselineRebuiltAt: state.restBaselineRebuiltAt ?? null,
        },
        pendingApprovals:
          req.opsSession!.role === "owner" ? pendingApprovals : undefined,
        pendingIsolation: opts.state.pendingIsolationActions().length,
        recentAudit: opts.state.listOpsAudit(30),
        campaignSetupPrompt: campaignSetupPrompt(),
      });
    } catch (error) {
      res.status(503).json({ error: safeMessage(error) });
    }
  });

  router.get("/placements", async (req: AuthenticatedRequest, res) => {
    try {
      const force = String(req.query.force ?? "") === "1";
      res.json(await opts.runtime.placements(force));
    } catch (error) {
      res.status(503).json({ error: safeMessage(error) });
    }
  });

  router.get(
    "/approvals",
    requireOwner,
    (req: AuthenticatedRequest, res) => {
      res.json({ approvals: opts.state.listSpendApprovals() });
    },
  );

  router.post(
    "/approvals/:id/:decision",
    requireOwner,
    async (req: AuthenticatedRequest, res) => {
      const decision = String(req.params.decision);
      if (!["approve", "deny"].includes(decision)) {
        res.status(400).json({ error: "Decision must be approve or deny" });
        return;
      }
      if (req.body?.confirm !== true) {
        res.status(400).json({ error: "Explicit confirmation is required" });
        return;
      }
      try {
        await audit(
          req.opsSession!,
          `spend-${decision}-confirmed`,
          "success",
          req.params.id,
          "Owner confirmed spend decision",
          true,
        );
      } catch (error) {
        res.status(503).json({ error: safeMessage(error) });
        return;
      }
      const status = decision === "approve" ? "approved" : "denied";
      const record = opts.state.decideSpendApproval(
        req.params.id,
        status,
        req.opsSession!.username,
      );
      if (!record) {
        res.status(409).json({ error: "Approval is not pending" });
        return;
      }
      try {
        await opts.state.save();
        await audit(
          req.opsSession!,
          `spend-${decision}`,
          "success",
          record.id,
          record.description,
        );
        res.json({ ok: true, record });
      } catch (error) {
        record.status = "pending";
        record.decidedAt = undefined;
        record.decidedBy = undefined;
        res.status(503).json({ error: safeMessage(error) });
      }
    },
  );

  router.get("/audit", (_req, res) => {
    res.json({ audit: opts.state.listOpsAudit(100) });
  });

  router.get("/isolation", (_req, res) => {
    const isolation = opts.state.getIsolation();
    res.json({
      actions: opts.state.listIsolationActions().sort((a, b) =>
        b.requestedAt.localeCompare(a.requestedAt),
      ),
      domains: opts.state.listDomainHistory(),
      runs: Object.values(isolation.runs)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 20),
    });
  });

  router.post(
    "/isolation/actions/:id/:decision",
    async (req: AuthenticatedRequest, res) => {
      if (!opts.isolationExecute) {
        res.status(503).json({ error: "Isolation actions are not wired yet." });
        return;
      }
      const decision = String(req.params.decision);
      if (decision !== "approve" && decision !== "deny") {
        res.status(400).json({ error: "Decision must be approve or deny" });
        return;
      }
      if (req.body?.confirm !== true) {
        res.status(400).json({ error: "Explicit confirmation is required" });
        return;
      }
      const action = opts.state.getIsolationAction(String(req.params.id));
      if (!action || action.status !== "pending") {
        res.status(409).json({ error: "That request is no longer waiting." });
        return;
      }
      const role = req.opsSession!.role;
      if (!canDecideIsolationAction(action.kind, role)) {
        await audit(
          req.opsSession!,
          "isolation-denied",
          "denied",
          action.id,
          action.kind === "swap_copy"
            ? "Josh or Cayden can switch the word."
            : "Only Josh can retire a domain or buy replacements.",
        );
        res.status(403).json({
          error:
            action.kind === "swap_copy"
              ? "Josh or Cayden can switch the word."
              : "Only Josh can retire a domain or buy replacements.",
        });
        return;
      }
      try {
        const result = await opts.isolationExecute.decide(
          action.id,
          decision,
          { name: req.opsSession!.username, role },
        );
        await audit(
          req.opsSession!,
          `isolation-${decision}`,
          result.ok ? "success" : "error",
          action.id,
          result.message,
          true,
        );
        res.status(result.ok ? 200 : 409).json(result);
      } catch (error) {
        const message = safeMessage(error);
        await audit(req.opsSession!, "isolation-decide", "error", action.id, message);
        res.status(500).json({ error: message });
      }
    },
  );

  router.get(
    "/cursor-run/:agentId/:runId",
    async (req: AuthenticatedRequest, res) => {
      const session = req.opsSession!;
      if (!opts.cursorAssistant) {
        res.status(503).json({ error: "Cursor assistant is not configured" });
        return;
      }
      const agentId = String(req.params.agentId || "");
      const runId = String(req.params.runId || "");
      if (!agentId.startsWith("bc-") || !runId.startsWith("run-")) {
        res.status(400).json({ error: "Invalid agent or run id" });
        return;
      }
      try {
        const result = await opts.cursorAssistant.poll(agentId, runId);
        if (!result.pending) {
          await audit(
            session,
            "cursor-agent",
            String(result.status).toUpperCase() === "FINISHED"
              ? "success"
              : "error",
            result.agentId,
            result.runId,
          );
        }
        res.json({
          message: result.message,
          data: {
            pending: Boolean(result.pending),
            agentId: result.agentId,
            agentUrl: result.agentUrl,
            runId: result.runId,
            status: result.status,
            prUrls: result.prUrls,
            model: result.model,
          },
        });
      } catch (error) {
        res.status(502).json({ error: safeMessage(error) });
      }
    },
  );

  router.post("/chat", async (req: AuthenticatedRequest, res) => {
    const session = req.opsSession!;
    const message = String(req.body?.message ?? "").trim().slice(0, 4_000);
    const intent = classifyOpsMessage(message, session.role);
    const respond = (
      text: string,
      data?: unknown,
      confirmation?: { type: "rotate"; email: string },
    ) => res.json({ message: text, data, confirmation });

    try {
      switch (intent.type) {
        case "help":
          await audit(session, "help", "success");
          respond(opsHelp(session.role));
          return;
        case "denied":
          await audit(session, "chat-command", "denied", undefined, intent.reason);
          respond(`I can't do that.\n\n${intent.reason}`);
          return;
        case "ask_cursor":
        case "unknown": {
          if (!opts.cursorAssistant) {
            await audit(
              session,
              "chat-command",
              "denied",
              undefined,
              "cursor assistant not configured",
            );
            respond(
              [
                "Freeform chat needs Cursor wired up.",
                "Josh: set `CURSOR_API_KEY` on Railway (from cursor.com/dashboard/api), redeploy, then ask again.",
                "",
                opsHelp(session.role),
              ].join("\n"),
            );
            return;
          }
          const question =
            intent.type === "ask_cursor" ? intent.message : message;
          // Start only — do not wait here. Long waits die on Railway/browser
          // timeouts and the UI looks like it never answered.
          const started = await opts.cursorAssistant.start({
            actor: session.username,
            role: session.role,
            message: question,
          });
          await audit(
            session,
            "cursor-agent-start",
            "success",
            started.agentId,
            started.runId,
            true,
          );
          respond(
            [
              `Got it — Cursor Grok 4.5 High Fast is working on this.`,
              `I'll post the answer here when it's ready.`,
              "",
              `Follow along: ${started.agentUrl}`,
            ].join("\n"),
            {
              pending: true,
              agentId: started.agentId,
              agentUrl: started.agentUrl,
              runId: started.runId,
              status: started.status,
              model: started.model,
            },
          );
          return;
        }
        case "status":
          await audit(session, "status", "success");
          respond(
            "Current operational status is refreshed in the dashboard cards.",
            { refreshDashboard: true },
          );
          return;
        case "campaign_setup":
          await audit(session, "campaign-setup", "success");
          respond(campaignSetupPrompt());
          return;
        case "approvals":
          if (session.role !== "owner") {
            const reason =
              "Only Josh can view or decide spend approvals. Cayden can run checks and safe mailbox rotations.";
            await audit(session, "approvals", "denied", undefined, reason);
            respond(`I can't do that.\n\n${reason}`);
            return;
          }
          await audit(session, "approvals", "success");
          respond("Pending spend requests are shown in the owner approval panel.", {
            refreshApprovals: true,
          });
          return;
        case "rotate": {
          const preview = await opts.rotation.preview(intent.email);
          await audit(
            session,
            "rotation-preview",
            preview.allowed ? "success" : "denied",
            intent.email,
            preview.allowed ? "safe to confirm" : preview.reasons.join("; "),
          );
          if (!preview.allowed) {
            respond(
              `Rotation is blocked:\n${preview.reasons.map((reason) => `• ${reason}`).join("\n")}`,
              preview,
            );
            return;
          }
          respond(
            [
              `Rotation preview for ${preview.email}:`,
              `• Replacement: ${preview.replacement?.email} (${preview.platform})`,
              `• Campaigns: ${preview.campaigns.map((campaign) => `#${campaign.id} ${campaign.name}`).join(", ")}`,
              `• Original warms until ${preview.holdUntil}`,
              "",
              "Nothing has changed yet. Use Confirm rotation to execute after revalidation.",
            ].join("\n"),
            preview,
            { type: "rotate", email: preview.email },
          );
          return;
        }
        case "deliverability":
        case "dns":
        case "campaigns":
        case "reconnect": {
          const lock = intent.type;
          if (actionLocks.has(lock)) {
            respond(`${lock} is already running. Wait for it to finish.`);
            return;
          }
          actionLocks.add(lock);
          try {
            const data =
              intent.type === "deliverability"
                ? await opts.runtime.deliverability()
                : intent.type === "dns"
                  ? await opts.runtime.dns()
                  : intent.type === "campaigns"
                    ? await opts.runtime.campaigns()
                    : await opts.runtime.reconnect();
            await audit(session, intent.type, "success");
            respond(
              `${intent.type === "reconnect" ? "Reconnect" : "Check"} completed successfully.`,
              data,
            );
          } finally {
            actionLocks.delete(lock);
          }
          return;
        }
      }
    } catch (error) {
      const errorMessage = safeMessage(error);
      await audit(session, intent.type, "error", undefined, errorMessage);
      res.status(500).json({
        error: errorMessage,
        message: `The operation failed safely: ${errorMessage}`,
      });
    }
  });

  router.post("/rotate", async (req: AuthenticatedRequest, res) => {
    const session = req.opsSession!;
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (req.body?.confirm !== "ROTATE") {
      res.status(400).json({ error: "Type ROTATE to confirm" });
      return;
    }
    try {
      await audit(
        session,
        "rotation-confirmed",
        "success",
        email,
        "Operator confirmed rotation after preview",
        true,
      );
    } catch (error) {
      res.status(503).json({ error: safeMessage(error) });
      return;
    }
    const lock = `rotate:${email}`;
    if (actionLocks.has(lock)) {
      res.status(409).json({ error: "Rotation is already running" });
      return;
    }
    actionLocks.add(lock);
    try {
      const result: RotationResult = await opts.executeRotation(email);
      await audit(
        session,
        "rotation-execute",
        result.completed ? "success" : result.errors.length ? "error" : "denied",
        email,
        result.completed
          ? `replacement ${result.preview.replacement?.email}`
          : [...result.preview.reasons, ...result.errors].join("; "),
      );
      res.status(result.completed ? 200 : 409).json({ result });
    } catch (error) {
      const message = safeMessage(error);
      await audit(session, "rotation-execute", "error", email, message);
      res.status(500).json({ error: message });
    } finally {
      actionLocks.delete(lock);
    }
  });

  return router;
}
