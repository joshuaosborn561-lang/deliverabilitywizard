import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildResolvedAskBlocks,
  resolveIsolationAskMessage,
  resolvedAskLabel,
  type FetchLike,
} from "./slackAskResolve.js";

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(
  responses: Array<{ ok: boolean; status?: number; json?: unknown }>,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
    const res = responses[i++] ?? { ok: true, status: 200, json: { ok: true } };
    return {
      ok: res.ok,
      status: res.status ?? (res.ok ? 200 : 500),
      json: async () => res.json ?? { ok: res.ok },
    };
  };
  return { fetch, calls };
}

describe("D195 — resolved ask blocks carry no actions", () => {
  it("has a summary + resolved section and never an actions block", () => {
    const blocks = buildResolvedAskBlocks({
      summary: "*TechEvo AirPods*",
      resolvedLabel: resolvedAskLabel("swap_copy", "approve"),
      detail: "Applied across 3 campaigns.",
    });
    assert.equal(
      blocks.some((b) => (b as { type?: string }).type === "actions"),
      false,
      "a resolved ask must have no actions block (buttons gone)",
    );
    const types = blocks.map((b) => (b as { type?: string }).type);
    assert.deepEqual(types, ["section", "section", "context"]);
  });

  it("labels each kind/decision", () => {
    assert.match(resolvedAskLabel("swap_copy", "approve"), /edit applied/i);
    assert.match(resolvedAskLabel("swap_copy", "deny"), /not now/i);
    assert.match(resolvedAskLabel("generic_backfill", "deny"), /generics stay off/i);
    assert.match(resolvedAskLabel("retire_domain", "approve"), /retired/i);
    assert.match(resolvedAskLabel("buy_domains", "approve"), /cover buy/i);
  });
});

describe("D195 — resolveIsolationAskMessage strip paths", () => {
  it("prefers response_url with replace_original and no actions", async () => {
    const { fetch, calls } = fakeFetch([{ ok: true }]);
    const result = await resolveIsolationAskMessage({
      responseUrl: "https://hooks.slack.com/actions/abc",
      channel: "C1",
      ts: "111.222",
      botToken: "xoxb-posting",
      summary: "*TechEvo AirPods*",
      kind: "swap_copy",
      decision: "approve",
      detail: "Applied fleet-wide.",
      fetchImpl: fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "response_url");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://hooks.slack.com/actions/abc");
    assert.equal(calls[0]?.body.replace_original, true);
    const blocks = calls[0]?.body.blocks as Array<{ type: string }>;
    assert.equal(blocks.some((b) => b.type === "actions"), false);
  });

  it("falls back to chat.update with the posting token when no response_url", async () => {
    const { fetch, calls } = fakeFetch([{ ok: true, json: { ok: true } }]);
    const result = await resolveIsolationAskMessage({
      channel: "C0BJQUTV7A8",
      ts: "333.444",
      botToken: "xoxb-posting",
      summary: "*Retire freshburn.info*",
      kind: "retire_domain",
      decision: "approve",
      fetchImpl: fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "chat_update");
    assert.equal(calls[0]?.url, "https://slack.com/api/chat.update");
    assert.equal(calls[0]?.body.channel, "C0BJQUTV7A8");
    assert.equal(calls[0]?.body.ts, "333.444");
    const blocks = calls[0]?.body.blocks as Array<{ type: string }>;
    assert.equal(blocks.some((b) => b.type === "actions"), false);
  });

  it("falls back to chat.update when response_url fails but coords exist", async () => {
    const { fetch, calls } = fakeFetch([
      { ok: false, status: 500 },
      { ok: true, json: { ok: true } },
    ]);
    const result = await resolveIsolationAskMessage({
      responseUrl: "https://hooks.slack.com/actions/broken",
      channel: "C1",
      ts: "1.2",
      botToken: "xoxb-posting",
      summary: "*x*",
      kind: "swap_copy",
      decision: "deny",
      fetchImpl: fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "chat_update");
    assert.equal(calls.length, 2);
  });

  it("reports none when nothing is available to strip", async () => {
    const { fetch, calls } = fakeFetch([]);
    const result = await resolveIsolationAskMessage({
      summary: "*x*",
      kind: "swap_copy",
      decision: "approve",
      fetchImpl: fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.via, "none");
    assert.equal(calls.length, 0);
  });

  it("surfaces cant_update_message from a non-posting token attempt", async () => {
    const { fetch } = fakeFetch([
      { ok: true, json: { ok: false, error: "cant_update_message" } },
    ]);
    const result = await resolveIsolationAskMessage({
      channel: "C1",
      ts: "1.2",
      botToken: "xoxb-not-poster",
      summary: "*x*",
      kind: "swap_copy",
      decision: "approve",
      fetchImpl: fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.via, "chat_update");
    assert.equal(result.error, "cant_update_message");
  });
});
