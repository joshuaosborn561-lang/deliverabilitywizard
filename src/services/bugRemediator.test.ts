import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../config.js";
import type { CursorCloudClient } from "../clients/cursorCloud.js";
import type { SlackClient } from "../clients/slack.js";
import { StateStore } from "../state/store.js";
import { BugRemediator, buildRemediatorPrompt } from "./bugRemediator.js";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      ENABLE_BUG_REMEDIATOR: "true",
      CURSOR_API_KEY: "test-key",
      BUG_REMEDIATOR_MIN_HITS: "2",
      BUG_REMEDIATOR_COOLDOWN_HOURS: "24",
      BUG_REMEDIATOR_AUTO_MERGE: "true",
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}

describe("BugRemediator", () => {
  it("waits for min hits before launching a Cursor agent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bug-rem-"));
    const state = new StateStore(path.join(dir, "state.json"));
    await state.load();

    let createCalls = 0;
    const cursor = {
      async createAgent() {
        createCalls += 1;
        return {
          agent: {
            id: "bc-bug-1",
            url: "https://cursor.com/agents/bc-bug-1",
          },
          run: { id: "run-1", agentId: "bc-bug-1", status: "CREATING" },
        };
      },
      async getAgent(id: string) {
        return { id, url: `https://cursor.com/agents/${id}` };
      },
      async createRun() {
        throw new Error("should create new agent first");
      },
    } as unknown as CursorCloudClient;

    const slackMessages: string[] = [];
    const slack = {
      async send(text: string) {
        slackMessages.push(text);
      },
    } as unknown as SlackClient;

    const remediator = new BugRemediator(
      testConfig(),
      cursor,
      slack,
      state,
    );

    const first = await remediator.observe(
      "scan",
      "scheduler_cron_value must be of type object",
    );
    assert.equal(first.launched, false);
    assert.equal(createCalls, 0);

    const second = await remediator.observe(
      "scan",
      "scheduler_cron_value must be of type object",
    );
    assert.equal(second.launched, true);
    assert.equal(createCalls, 1);
    assert.equal(slackMessages.length, 1);
    assert.match(slackMessages[0]!, /same error/);
    assert.doesNotMatch(slackMessages[0]!, /Fingerprint/);

    const third = await remediator.observe(
      "scan",
      "scheduler_cron_value must be of type object",
    );
    assert.equal(third.launched, false, "cooldown should block re-launch");
    assert.equal(createCalls, 1);

    await rm(dir, { recursive: true, force: true });
  });

  it("skips noise without launching", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bug-rem-noise-"));
    const state = new StateStore(path.join(dir, "state.json"));
    await state.load();

    let createCalls = 0;
    const cursor = {
      async createAgent() {
        createCalls += 1;
        return {
          agent: { id: "x", url: "https://cursor.com/agents/x" },
          run: { id: "r", agentId: "x", status: "CREATING" },
        };
      },
    } as unknown as CursorCloudClient;

    const remediator = new BugRemediator(
      testConfig(),
      cursor,
      { async send() {} } as unknown as SlackClient,
      state,
    );

    for (let i = 0; i < 5; i += 1) {
      const { launched, classified } = await remediator.observe(
        "scan",
        "HTTP 429 rate limit",
      );
      assert.equal(classified.autoRemediate, false);
      assert.equal(launched, false);
    }
    assert.equal(createCalls, 0);

    await rm(dir, { recursive: true, force: true });
  });

  it("buildRemediatorPrompt forbids spend/delete and mentions auto-merge", () => {
    const prompt = buildRemediatorPrompt(
      {
        class: "api_validation",
        fingerprint: "api_validation:scheduler_cron_value",
        autoRemediate: true,
        summary: "validation",
        raw: "scheduler_cron_value must be of type object",
      },
      {
        fingerprint: "api_validation:scheduler_cron_value",
        failureClass: "api_validation",
        summary: "validation",
        source: "scan",
        count: 3,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T01:00:00.000Z",
        status: "watching",
      },
      testConfig({ bugRemediatorAutoMerge: true }),
    );
    assert.match(prompt, /Never buy domains/);
    assert.match(prompt, /Never delete/);
    assert.match(prompt, /merge the PR/);
    assert.match(prompt, /scheduler_cron_value/);
  });
});
