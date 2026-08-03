import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CursorCloudClient } from "../clients/cursorCloud.js";
import { StateStore } from "../state/store.js";
import { CursorAssistantService } from "./cursorAssistant.js";

describe("CursorAssistantService", () => {
  it("creates a Grok agent on first ask and resumes on the next", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ops-cursor-"));
    const state = new StateStore(path.join(dir, "state.json"));
    await state.load();

    const calls: string[] = [];
    const client = {
      async getAgent(id: string) {
        calls.push(`getAgent:${id}`);
        return { id, url: `https://cursor.com/agents/${id}` };
      },
      async createAgent() {
        calls.push("createAgent");
        return {
          agent: {
            id: "bc-test-1",
            url: "https://cursor.com/agents/bc-test-1",
          },
          run: { id: "run-1", agentId: "bc-test-1", status: "CREATING" },
        };
      },
      async createRun(agentId: string) {
        calls.push(`createRun:${agentId}`);
        return {
          run: { id: "run-2", agentId, status: "CREATING" },
        };
      },
      async waitForRun(agentId: string, runId: string) {
        calls.push(`wait:${agentId}:${runId}`);
        return {
          id: runId,
          agentId,
          status: "FINISHED",
          result: "Bounce stats use name-wise health metrics.",
        };
      },
    } as unknown as CursorCloudClient;

    const assistant = new CursorAssistantService(client, state, {
      repositoryUrl: "https://github.com/example/repo",
      startingRef: "main",
      model: {
        id: "grok-4.5",
        params: [
          { id: "effort", value: "high" },
          { id: "fast", value: "true" },
        ],
      },
      timeoutMs: 5_000,
    });

    const first = await assistant.ask({
      actor: "cayden",
      role: "operator",
      message: "Why did bounce stats 404?",
    });
    assert.equal(first.agentId, "bc-test-1");
    assert.match(first.message, /Bounce stats use name-wise/);
    assert.equal(state.getOpsCursorAgentId("cayden"), "bc-test-1");
    assert.ok(calls.includes("createAgent"));

    const second = await assistant.ask({
      actor: "cayden",
      role: "operator",
      message: "And what about Scott?",
    });
    assert.equal(second.agentId, "bc-test-1");
    assert.ok(calls.some((c) => c.startsWith("createRun:bc-test-1")));

    await rm(dir, { recursive: true, force: true });
  });
});
