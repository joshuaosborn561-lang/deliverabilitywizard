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

  it("D153: swap_copy offers Write my own edit without a URL (modal path)", async () => {
    const client = new SlackClient({
      channelLabel: "#test",
      actionLinkSecret: "secret",
      publicBaseUrl: "https://example.test",
    });
    let text = "";
    let blocks: unknown[] | undefined;
    (client as unknown as {
      send: (t: string, next?: unknown[], _kind?: string) => Promise<void>;
    }).send = async (t, next) => {
      text = t;
      blocks = next;
    };

    await client.notifyIsolationAction({
      title: "It was Air Pods on Goliath",
      proof: "Hunt recovered when that opener was gone.",
      actionId: "swap_copy-1",
      kind: "swap_copy",
      who: "Josh or Cayden",
      element:
        "{I've got|I have} {an extra|a spare} pair of Air Pods {for you|with your name on them}.",
      suggestedSwap: "Quick note from our pen-test work.",
      campaignName: "Goliath Education Receipts - Large Public",
    });

    assert.match(text, /REMOVE this exact text/);
    assert.match(text, /REPLACE WITH/);
    assert.match(text, /```[\s\S]*Air Pods[\s\S]*```/);
    assert.match(text, /```[\s\S]*Quick note from our pen-test work[\s\S]*```/);
    assert.doesNotMatch(text, /\*Suggested edit:\*/);
    assert.match(text, /Air Pods/);
    assert.match(text, /Write my own edit/);
    const actions = (
      blocks as Array<{
        elements?: Array<{
          url?: string;
          action_id?: string;
          text?: { text?: string };
          value?: string;
        }>;
      }>
    )[1]?.elements;
    assert.equal(actions?.length, 3);
    assert.equal(actions?.[0]?.text?.text, "Use suggested edit");
    assert.ok(actions?.[0]?.url, "suggested edit still uses confirm-page URL");
    assert.equal(actions?.[1]?.text?.text, "Write my own edit");
    assert.equal(actions?.[1]?.action_id, "isolation_swap_edit");
    assert.equal(actions?.[1]?.url, undefined, "modal button must not set url");
    assert.match(actions?.[1]?.value ?? "", /:edit$/);
    assert.equal(actions?.[2]?.text?.text, "Not now");
  });
});
