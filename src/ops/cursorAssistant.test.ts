import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CursorCloudClient } from "../clients/cursorCloud.js";
import { StateStore } from "../state/store.js";
import { CursorAssistantService } from "./cursorAssistant.js";

describe("CursorAssistantService", () => {
  it("starts a run immediately and polls until finished", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ops-cursor-"));
    const state = new StateStore(path.join(dir, "state.json"));
    await state.load();

    let polls = 0;
    let lastCreateAgent: { autoCreatePR?: boolean } | undefined;
    const client = {
      async getAgent(id: string) {
        return { id, url: `https://cursor.com/agents/${id}` };
      },
      async createAgent(input: { autoCreatePR?: boolean }) {
        lastCreateAgent = input;
        return {
          agent: {
            id: "bc-test-1",
            url: "https://cursor.com/agents/bc-test-1",
          },
          run: { id: "run-1", agentId: "bc-test-1", status: "CREATING" },
        };
      },
      async createRun(agentId: string) {
        return {
          run: { id: "run-2", agentId, status: "CREATING" },
        };
      },
      async getRun(agentId: string, runId: string) {
        polls += 1;
        if (polls < 2) {
          return { id: runId, agentId, status: "RUNNING" };
        }
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

    const started = await assistant.start({
      actor: "cayden",
      role: "operator",
      message: "Why did bounce stats 404?",
    });
    assert.equal(started.agentId, "bc-test-1");
    assert.equal(started.runId, "run-1");
    assert.equal(lastCreateAgent?.autoCreatePR, true);
    assert.equal(state.getOpsCursorAgentId("cayden"), "bc-test-1");

    const pending = await assistant.poll(started.agentId, started.runId);
    assert.equal(pending.pending, true);

    const done = await assistant.poll(started.agentId, started.runId);
    assert.equal(done.pending, false);
    assert.match(done.message, /Bounce stats use name-wise/);
    assert.match(done.message, /cursor\.com\/agents\/bc-test-1/);

    const second = await assistant.start({
      actor: "cayden",
      role: "operator",
      message: "And Scott?",
    });
    assert.equal(second.runId, "run-2");

    await rm(dir, { recursive: true, force: true });
  });
});
