import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlackClient } from "./slack.js";
import { verifySlackActionLink } from "../lib/slackActionLink.js";

describe("isolation Slack URL buttons", () => {
  it("puts a signed confirm-page URL on retire / replace", async () => {
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
      title: "Retire hubmeetconnect.com",
      proof: "Same-ESP Gmail→Gmail 0% on 8 seeds.",
      actionId: "retire_domain-1-abc",
      kind: "retire_domain",
      who: "Josh",
    });

    const actions = (
      blocks as Array<{ elements?: Array<{ url?: string; text?: { text?: string } }> }>
    )[1]?.elements;
    const approve = actions?.[0];
    assert.ok(approve?.url);
    assert.equal(approve.text?.text, "Retire this domain");
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
