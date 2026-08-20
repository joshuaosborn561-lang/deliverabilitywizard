/**
 * Thin client for Cursor Cloud Agents API (v1).
 * https://cursor.com/docs/cloud-agent/api/endpoints
 */

import { ApiError } from "../lib/http.js";

const BASE_URL = "https://api.cursor.com/v1/";

export interface CursorModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

export interface CursorAgentRef {
  id: string;
  name?: string;
  url?: string;
  status?: string;
}

export interface CursorRunRef {
  id: string;
  agentId: string;
  status: string;
  result?: string;
  durationMs?: number;
  git?: {
    branches?: Array<{ repoUrl: string; branch?: string; prUrl?: string }>;
  };
}

export class CursorCloudClient {
  constructor(private readonly apiKey: string) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), BASE_URL).toString();
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const message =
        typeof parsed === "object" &&
        parsed &&
        ("message" in parsed || "error" in parsed)
          ? String(
              (parsed as { message?: unknown; error?: unknown }).message ??
                (parsed as { error?: unknown }).error,
            )
          : `HTTP ${response.status}`;
      throw new ApiError(message, response.status, parsed);
    }
    return parsed as T;
  }

  createAgent(input: {
    prompt: string;
    model: CursorModelSelection;
    repositoryUrl: string;
    startingRef?: string;
    name?: string;
    mode?: "agent" | "plan";
    autoCreatePR?: boolean;
  }): Promise<{ agent: CursorAgentRef; run: CursorRunRef }> {
    return this.request("POST", "agents", {
      prompt: { text: input.prompt },
      model: input.model,
      name: input.name,
      mode: input.mode ?? "agent",
      autoCreatePR: input.autoCreatePR ?? true,
      repos: [
        {
          url: input.repositoryUrl,
          startingRef: input.startingRef ?? "main",
        },
      ],
    });
  }

  createRun(
    agentId: string,
    input: { prompt: string; mode?: "agent" | "plan" },
  ): Promise<{ run: CursorRunRef }> {
    return this.request("POST", `agents/${encodeURIComponent(agentId)}/runs`, {
      prompt: { text: input.prompt },
      mode: input.mode ?? "agent",
    });
  }

  getRun(agentId: string, runId: string): Promise<CursorRunRef> {
    return this.request(
      "GET",
      `agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    );
  }

  getAgent(agentId: string): Promise<CursorAgentRef> {
    return this.request("GET", `agents/${encodeURIComponent(agentId)}`);
  }

  /**
   * Poll until the run reaches a terminal status or the timeout elapses.
   */
  async waitForRun(
    agentId: string,
    runId: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<CursorRunRef> {
    const timeoutMs = options.timeoutMs ?? 8 * 60_000;
    const pollMs = options.pollMs ?? 2_500;
    const started = Date.now();
    for (;;) {
      const run = await this.getRun(agentId, runId);
      const status = String(run.status || "").toUpperCase();
      if (
        status === "FINISHED" ||
        status === "ERROR" ||
        status === "CANCELLED" ||
        status === "EXPIRED"
      ) {
        return run;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `Cursor agent run timed out after ${Math.round(timeoutMs / 1000)}s (status ${run.status}). Open the agent URL to follow along.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
