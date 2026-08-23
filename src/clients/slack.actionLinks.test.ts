import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlackClient } from "./slack.js";
import { verifySlackActionLink } from "../lib/slackActionLink.js";

describe("isolation Slack URL buttons", () => {
  it("puts a signed confirm-page URL on Buy canary fleet", async () => {
    const client = new SlackClient({
      channelLabel: "#test",
      actionLinkSecret: "secret",
      publicBaseUrl: "https://example.test",
    });
    let blocks: unknown[] | undefined;
    (client as unknown as { send: (text: string, next?: unknown[]) => Promise<void> }).send =
      async (_text, next) => {
        blocks = next;
      };

    await client.notifyIsolationAction({
      title: "Buy the unwarmed canary fleet",
      proof: "The fleet is not bought yet.",
      actionId: "buy_canary_fleet-1-abc",
      kind: "buy_canary_fleet",
      who: "Josh",
    });

    const actions = (
      blocks as Array<{ elements?: Array<{ url?: string; text?: { text?: string } }> }>
    )[1]?.elements;
    const approve = actions?.[0];
    assert.ok(approve?.url);
    assert.equal(approve.text?.text, "Buy canary fleet");
    const url = new URL(approve.url);
    assert.equal(url.origin, "https://example.test");
    assert.equal(url.pathname, "/slack/action");
    const verified = verifySlackActionLink({
      secret: "secret",
      id: url.searchParams.get("id") ?? "",
      decision: url.searchParams.get("decision") ?? "",
      exp: url.searchParams.get("exp") ?? "",
      sig: url.searchParams.get("sig") ?? "",
    });
    assert.deepEqual(verified, { ok: true, decision: "approve" });
  });
});
