import type { CursorCloudClient } from "../clients/cursorCloud.js";
import type { CursorModelSelection } from "../clients/cursorCloud.js";
import type { StateStore } from "../state/store.js";
import type { OpsRole } from "./auth.js";
import { campaignSetupPrompt } from "./campaignSetupPrompt.js";

export interface CursorAssistantStart {
  agentId: string;
  agentUrl: string;
  runId: string;
  status: string;
  model: string;
}

export interface CursorAssistantResult {
  message: string;
  agentId: string;
  agentUrl: string;
  runId: string;
  status: string;
  prUrls?: string[];
  pending?: boolean;
  model: string;
}

const MODEL_LABEL = "Cursor Grok 4.5 High Fast";

function policyPreamble(actor: string, role: OpsRole): string {
  return [
    `You are the Deliverability Wizard assistant for ${actor} (${role}).`,
    "You are running as a Cursor Cloud Agent on the deliverabilitywizard repo,",
    "using Cursor Grok 4.5 High Fast — same style as Josh's Cursor agent:",
    "direct, concise, plain English, no fluff.",
    "",
    "Hard rules (do not violate):",
    "- Never buy domains, mailboxes, or spend money unless Josh has already",
    "  approved a spend request. Prefer explaining how to use the approval gateway.",
    "- Never delete/purge domains or mailboxes from chat unless Josh explicitly",
    "  approved that exact destructive action.",
    "- Never bypass warmup, recovery holds, or spend-approval safety gates.",
    "- Never change fleet policy (50-sender floor, 30/day cap, per-client A/B rest, 21-day",
    "  fresh warmup, thresholds) without a reviewed PR and Josh's decision",
    "  recorded in DECISIONS.md.",
    "- Prefer investigate → explain → PR. Do not deploy by pushing to main.",
    "- For Cayden (operator): keep responses operational; refuse spend/policy",
    "  overrides and explain why.",
    "",
    "Allowed: diagnose deliverability, inspect code/logs/state patterns, propose",
    "or implement fixes on a feature branch via PR, answer questions about how",
    "the system works, and suggest safe next steps.",
    "",
    campaignSetupPrompt(),
    "",
  ].join("\n");
}

function agentUrlFor(id: string, url?: string): string {
  return url || `https://cursor.com/agents/${id}`;
}

export class CursorAssistantService {
  constructor(
    private readonly client: CursorCloudClient,
    private readonly state: StateStore,
    private readonly options: {
      repositoryUrl: string;
      startingRef: string;
      model: CursorModelSelection;
      timeoutMs: number;
    },
  ) {}

  /**
   * Start a Cursor run and return immediately so the Ops UI can poll.
   * Holding the HTTP request open until the agent finishes often dies on
   * Railway/browser timeouts — that looked like "never answered."
   */
  async start(input: {
    actor: string;
    role: OpsRole;
    message: string;
  }): Promise<CursorAssistantStart> {
    const existingId = this.state.getOpsCursorAgentId(input.actor);
    const promptBody = input.message.trim();

    if (existingId) {
      try {
        const agent = await this.client.getAgent(existingId);
        const created = await this.client.createRun(existingId, {
          prompt: promptBody,
          mode: "agent",
        });
        return {
          agentId: existingId,
          agentUrl: agentUrlFor(existingId, agent.url),
          runId: created.run.id,
          status: created.run.status,
          model: MODEL_LABEL,
        };
      } catch (error) {
        console.warn(
          `[ops-cursor] resume failed for ${existingId}; creating new agent`,
          error instanceof Error ? error.message : error,
        );
        this.state.clearOpsCursorAgentId(input.actor);
      }
    }

    const prompt = `${policyPreamble(input.actor, input.role)}${promptBody}`;
    const created = await this.client.createAgent({
      prompt,
      model: this.options.model,
      repositoryUrl: this.options.repositoryUrl,
      startingRef: this.options.startingRef,
      name: `Ops UI — ${input.actor}`,
      mode: "agent",
      autoCreatePR: false,
    });
    this.state.setOpsCursorAgentId(input.actor, created.agent.id);
    await this.state.save();

    return {
      agentId: created.agent.id,
      agentUrl: agentUrlFor(created.agent.id, created.agent.url),
      runId: created.run.id,
      status: created.run.status,
      model: MODEL_LABEL,
    };
  }

  async poll(
    agentId: string,
    runId: string,
  ): Promise<CursorAssistantResult> {
    const run = await this.client.getRun(agentId, runId);
    const status = String(run.status || "").toUpperCase();
    const agentUrl = agentUrlFor(agentId);
    const terminal =
      status === "FINISHED" ||
      status === "ERROR" ||
      status === "CANCELLED" ||
      status === "EXPIRED";

    if (!terminal) {
      return {
        pending: true,
        message: `Still working in Cursor…\n${agentUrl}`,
        agentId,
        agentUrl,
        runId,
        status: run.status,
        model: MODEL_LABEL,
      };
    }

    return this.toResult({ id: agentId, url: agentUrl }, run);
  }

  private toResult(
    agent: { id: string; url?: string },
    run: {
      id: string;
      status: string;
      result?: string;
      git?: { branches?: Array<{ prUrl?: string }> };
    },
  ): CursorAssistantResult {
    const agentUrl = agentUrlFor(agent.id, agent.url);
    const status = String(run.status || "").toUpperCase();
    const prUrls = (run.git?.branches ?? [])
      .map((b) => b.prUrl)
      .filter((u): u is string => Boolean(u));

    let message =
      (run.result && run.result.trim()) ||
      (status === "FINISHED"
        ? "Done — open the Cursor agent for details."
        : `Cursor agent ended with status ${run.status}.`);

    const footer = [
      "",
      `— ${MODEL_LABEL}`,
      agentUrl,
      prUrls.length ? `PR: ${prUrls.slice(0, 3).join(", ")}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    if (!message.includes(agentUrl)) {
      message = `${message}${footer}`;
    }

    return {
      pending: false,
      message,
      agentId: agent.id,
      agentUrl,
      runId: run.id,
      status: run.status,
      prUrls: prUrls.length ? prUrls : undefined,
      model: MODEL_LABEL,
    };
  }
}
