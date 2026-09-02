import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SlackClient } from "../clients/slack.js";
import { StateStore } from "../state/store.js";
import {
  buildIsolationAction,
  classifyLineJob,
  dismissPendingSignatureAsks,
  isBannedCopySwap,
  preferEllipsis,
  refreshCopySwapAction,
  remindPendingIsolationActions,
  requestIsolationAction,
  suggestedCopySwap,
} from "./isolationActions.js";

function slackCapture() {
  const notified: string[] = [];
  const slack = {
    notifyIsolationAction: async (details: { actionId: string }) => {
      notified.push(details.actionId);
    },
  } as unknown as SlackClient;
  return { slack, notified };
}

function tempStore(): StateStore {
  return new StateStore(
    `/tmp/dw-iso-actions-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

describe("isolation Slack reminds", () => {
  it("skips a second request for the same pending canary buy", async () => {
    const store = tempStore();
    const { slack, notified } = slackCapture();
    const action = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy canary fleet",
      proof: "Fleet is missing.",
      detail: {},
    });
    const first = await requestIsolationAction({ store, slack, action });
    const second = await requestIsolationAction({
      store,
      slack,
      action: buildIsolationAction({
        kind: "buy_canary_fleet",
        title: "Buy canary fleet",
        proof: "Still missing.",
        detail: {},
      }),
    });
    assert.ok(first);
    assert.equal(second, null);
    assert.deepEqual(notified, [action.id]);
  });

  it("D97: leftover Add %signature% asks are dismissed and never re-posted", async () => {
    const store = tempStore();
    const { slack, notified } = slackCapture();
    const leftover = buildIsolationAction({
      kind: "add_signature_tag",
      title: "%signature% missing on SalesGlider Nurture",
      proof: "#3122546 SalesGlider Nurture is blocked at QA",
      detail: { campaignId: 3122546 },
    });
    store.upsertIsolationAction(leftover);
    const dropped = dismissPendingSignatureAsks(store);
    const count = await remindPendingIsolationActions({ store, slack });
    assert.equal(dropped, 1);
    assert.equal(count, 0);
    assert.deepEqual(notified, []);
    assert.equal(store.pendingIsolationActions().length, 0);
  });

  it("re-posts pending buttons without creating a new ask", async () => {
    const store = tempStore();
    const { slack, notified } = slackCapture();
    const action = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy canary fleet",
      proof: "Fleet is missing.",
      detail: {},
    });
    await requestIsolationAction({ store, slack, action });
    const count = await remindPendingIsolationActions({ store, slack });
    assert.equal(count, 1);
    assert.deepEqual(notified, [action.id, action.id]);
    assert.equal(store.pendingIsolationActions().length, 1);
    assert.equal(store.pendingIsolationActions()[0]?.id, action.id);
  });

  it("does not request or remind a canary buy after one is executed (D60)", async () => {
    const store = tempStore();
    const { slack, notified } = slackCapture();
    const executed = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy canary fleet",
      proof: "Bought.",
      detail: { domains: ["getcrosslaunchco.info"] },
    });
    store.upsertIsolationAction({ ...executed, status: "executed" });
    const leftover = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy canary fleet",
      proof: "Again.",
      detail: {},
    });
    store.upsertIsolationAction(leftover);
    const second = await requestIsolationAction({
      store,
      slack,
      action: buildIsolationAction({
        kind: "buy_canary_fleet",
        title: "Buy canary fleet",
        proof: "Still.",
        detail: {},
      }),
    });
    assert.equal(second, null);
    const count = await remindPendingIsolationActions({ store, slack });
    assert.equal(count, 0);
    assert.deepEqual(notified, []);
  });

});

describe("D137 — one isolation-domain buy ask, ever", () => {
  it("an executed buy means the rig never asks again", async () => {
    const store = new StateStore(
      `/tmp/dw-iso-ask-${process.pid}-${Date.now()}.json`,
    );
    await store.load();
    const { slack, notified } = slackCapture();
    const ask = () =>
      buildIsolationAction({
        kind: "buy_isolation_domain",
        title: "Arm the word-hunt rig: buy its isolation domain",
        proof: "Still.",
        detail: { quantity: 1, isolationRig: true },
      });
    const first = await requestIsolationAction({ store, slack, action: ask() });
    assert.ok(first, "first ask posts");
    assert.equal(first?.allowed, "owner", "spend asks are owner-only");
    // pending → dedupe
    assert.equal(await requestIsolationAction({ store, slack, action: ask() }), null);
    // executed → still dedupe: the rig is armed for life
    store.upsertIsolationAction({
      ...first!,
      status: "executed",
      executedAt: new Date().toISOString(),
    });
    assert.equal(await requestIsolationAction({ store, slack, action: ask() }), null);
    assert.equal(notified.length, 1);
  });
});

describe("D137 — a denied isolation-domain buy also never re-asks", () => {
  it("deny stands until Josh says otherwise", async () => {
    const store = new StateStore(
      `/tmp/dw-iso-deny-${process.pid}-${Date.now()}.json`,
    );
    await store.load();
    const { slack, notified } = slackCapture();
    const first = await requestIsolationAction({
      store,
      slack,
      action: buildIsolationAction({
        kind: "buy_isolation_domain",
        title: "Arm the word-hunt rig: buy its isolation domain",
        proof: "Still.",
        detail: { quantity: 1, isolationRig: true },
      }),
    });
    store.upsertIsolationAction({
      ...first!,
      status: "denied",
      decidedAt: new Date().toISOString(),
      decidedBy: "Josh",
    });
    const again = await requestIsolationAction({
      store,
      slack,
      action: buildIsolationAction({
        kind: "buy_isolation_domain",
        title: "Arm the word-hunt rig: buy its isolation domain",
        proof: "Still.",
        detail: { quantity: 1, isolationRig: true },
      }),
    });
    assert.equal(again, null, "a deny is an answer, not a snooze");
    assert.equal(notified.length, 1);
  });
});

function assertOfferSwap(element: string, offer: RegExp, context?: string) {
  const swap = suggestedCopySwap(element, context ? { context } : undefined);
  assert.match(swap, offer, `offer keyword lost for ${JSON.stringify(element)}`);
  assert.doesNotMatch(
    swap,
    /pen-test|school-district|Quick note/i,
    `offer opener must not become pen-test or Quick note: ${swap}`,
  );
  assert.notEqual(swap.trim(), "");
}

describe("suggestedCopySwap — D152 / D168 keep the line's job", () => {
  it("classifies spam-token / offer / CTA / generic", () => {
    assert.equal(classifyLineJob("winner"), "spam-token");
    assert.equal(
      classifyLineJob("I've got a jet ski you can take out this weekend."),
      "gift-or-experience-offer",
    );
    assert.equal(
      classifyLineJob("Worth a reply?"),
      "cta",
    );
    assert.equal(
      classifyLineJob("We help commercial properties around Atlanta."),
      "generic",
    );
  });

  it("keeps AirPods intent and drops bait phrasing", () => {
    assert.equal(
      classifyLineJob(
        "{I've got|I have} {an extra|a spare} pair of Air Pods {for you|with your name on them}.",
      ),
      "gift-or-experience-offer",
    );
    assertOfferSwap(
      "{I've got|I have} {an extra|a spare} pair of Air Pods {for you|with your name on them}.",
      /Air\s*Pods/i,
    );
  });

  it("keeps jet ski intent without requiring 'for you'", () => {
    assertOfferSwap(
      "I've got a jet ski you can take out this weekend.",
      /jet\s*ski/i,
    );
    assertOfferSwap("Got a jet ski sitting unused Saturday.", /jet\s*ski/i);
  });

  it("keeps Red Sox / Local_Sports_Team ticket offers", () => {
    assertOfferSwap(
      "I've got Red Sox tickets if you want them.",
      /tickets|Red Sox/i,
    );
    assertOfferSwap(
      "I've got a couple {{Local_Sports_Team}} tickets — want them, on me?",
      /tickets/i,
    );
    const local = suggestedCopySwap(
      "I've got a couple {{Local_Sports_Team}} tickets — want them, on me?",
    );
    assert.match(local, /Local_Sports_Team|tickets/i);
  });

  it("uses fuller sentence context when the hunt slice hid the offer", () => {
    const full =
      "Wanted to see if you were around because a client left us their extra pair of AirPods.";
    const sliced = full.slice(0, 80);
    assert.equal(
      classifyLineJob(sliced, { context: full }),
      "gift-or-experience-offer",
    );
    assertOfferSwap(sliced, /Air\s*Pods/i, full);
  });

  it("does not emit Quick note — or school-district pen-test for offers", () => {
    for (const line of [
      "I've got a jet ski you can take out this weekend.",
      "I've got Red Sox tickets if you want them.",
      "{I've got|I have} {an extra|a spare} pair of Air Pods {for you|with your name on them}.",
    ]) {
      const swap = suggestedCopySwap(line, { campaignName: "TechEvo AirPods" });
      assert.doesNotMatch(swap, /Quick note|pen-test|school-district/i);
      assert.doesNotMatch(swap, /^Quick note —$/);
    }
    const goliath = suggestedCopySwap(
      "I've got a pair of Air Pods for you.",
      { campaignName: "Goliath L1 AirPods", client: "Goliath" },
    );
    assert.match(goliath, /Air\s*Pods/i);
    assert.doesNotMatch(goliath, /pen-test|school-district|Quick note/i);
  });

  it("CTA gift closers keep the offer, not a receipts-report rewrite", () => {
    const swap = suggestedCopySwap(
      "P.S. Tickets are yours either way just for your time.",
    );
    assert.match(swap, /tickets/i);
    assert.doesNotMatch(swap, /receipts report|pen-test|Quick note/i);
  });

  it("still deletes pure spam tokens and maps synonyms", () => {
    assert.equal(suggestedCopySwap("winner"), "");
    assert.equal(suggestedCopySwap("free"), "complimentary");
  });

  it("generic long lines keep their meaning instead of Quick note —", () => {
    const line = "We help commercial properties around Atlanta use their building as an asset.";
    const swap = suggestedCopySwap(line);
    assert.match(swap, /commercial properties|Atlanta/i);
    assert.doesNotMatch(swap, /Quick note|pen-test|school-district/i);
  });
});

describe("D170 — refresh stale swap_copy on remind; classifier harden", () => {
  it("remind refreshes a frozen Quick note swap before Slack", async () => {
    const store = tempStore();
    const notified: Array<{ actionId: string; suggestedSwap?: string; proof?: string }> =
      [];
    const slack = {
      notifyIsolationAction: async (details: {
        actionId: string;
        suggestedSwap?: string;
        proof?: string;
      }) => {
        notified.push(details);
      },
    } as unknown as SlackClient;
    const element =
      "{I've got|I have} {an extra|a spare} pair of Air Pods {for you|with your name on them}.";
    const stale = buildIsolationAction({
      kind: "swap_copy",
      title: `It was “${element}” on TechEvo AirPods`,
      proof: "Suggested edit: *Quick note —*.",
      detail: {
        campaignId: 3799001,
        campaignName: "TechEvo AirPods",
        element,
        swap: "Quick note —",
      },
    });
    store.upsertIsolationAction(stale);
    const count = await remindPendingIsolationActions({ store, slack });
    assert.equal(count, 1);
    const updated = store.pendingIsolationActions()[0];
    assert.ok(updated);
    assert.equal(updated.id, stale.id);
    assert.match(String(updated.detail.swap), /Air\s*Pods/i);
    assert.doesNotMatch(String(updated.detail.swap), /Quick note|pen-test|school-district/i);
    assert.doesNotMatch(String(updated.detail.swap), /—/);
    assert.match(updated.proof, /Air\s*Pods/i);
    assert.doesNotMatch(updated.proof, /Quick note/);
    assert.equal(notified.length, 1);
    assert.match(notified[0]?.suggestedSwap ?? "", /Air\s*Pods/i);
    assert.doesNotMatch(notified[0]?.suggestedSwap ?? "", /Quick note|pen-test/i);
  });

  it("remind does not re-page a swap that is still a banned default", async () => {
    const store = tempStore();
    const { slack, notified } = slackCapture();
    const stale = buildIsolationAction({
      kind: "swap_copy",
      title: "It was winner on TechEvo",
      proof: "Suggested edit: *Quick note — from our school-district pen-test work.*",
      detail: {
        campaignName: "TechEvo",
        element: "winner",
        swap: "Quick note — from our school-district pen-test work.",
      },
    });
    store.upsertIsolationAction(stale);
    const count = await remindPendingIsolationActions({ store, slack });
    // "winner" is a spam-token → blank delete, not banned. Still posts.
    // A line whose refresh cannot escape the banned defaults is the skip.
    assert.equal(count, 1);
    assert.equal(store.pendingIsolationActions()[0]?.detail.swap, "");
    assert.deepEqual(notified, [stale.id]);

    const stillBanned = buildIsolationAction({
      kind: "swap_copy",
      title: "It was a phrase on TechEvo",
      proof: "Suggested edit: *Quick note —*.",
      detail: {
        campaignName: "TechEvo",
        // Empty element cannot be recomputed; banned swap must not Slack.
        element: "",
        swap: "Quick note — from our school-district pen-test work.",
      },
    });
    const store2 = tempStore();
    const capture2 = slackCapture();
    store2.upsertIsolationAction(stillBanned);
    const skipped = await remindPendingIsolationActions({
      store: store2,
      slack: capture2.slack,
    });
    assert.equal(skipped, 0);
    assert.deepEqual(capture2.notified, []);
  });

  it("refreshCopySwapAction rewrites a frozen identity-line Quick note", () => {
    const action = buildIsolationAction({
      kind: "swap_copy",
      title: "It was identity on TechEvo",
      proof: "Suggested edit: *Quick note —*.",
      detail: {
        campaignName: "TechEvo L1",
        element: "Hey, we're TechEvolution and we help IT teams stay online.",
        swap: "Quick note —",
      },
    });
    const next = refreshCopySwapAction(action);
    assert.match(String(next.detail.swap), /TechEvolution/i);
    assert.doesNotMatch(String(next.detail.swap), /Quick note|pen-test|school-district/i);
    assert.doesNotMatch(String(next.detail.swap), /—/);
    assert.equal(isBannedCopySwap(String(next.detail.swap)), false);
  });

  it("classifies truncated {{Local_Sports_Team as a sports-ticket offer", () => {
    const sliced = "I've got a couple {{Local_Sports_Team";
    assert.equal(classifyLineJob(sliced), "gift-or-experience-offer");
    const swap = suggestedCopySwap(sliced);
    assert.match(swap, /Local_Sports_Team|tickets/i);
    assert.doesNotMatch(swap, /Quick note|pen-test|school-district/i);
    assert.doesNotMatch(swap, /—/);
  });

  it("keeps company identity on we're-TechEvolution openers", () => {
    const line = "Hey — we're TechEvolution, reaching out about your IT stack.";
    assert.equal(classifyLineJob(line), "generic");
    const swap = suggestedCopySwap(line);
    assert.match(swap, /TechEvolution/i);
    assert.doesNotMatch(swap, /Quick note|pen-test|school-district/i);
    assert.doesNotMatch(swap, /—/);
    assert.match(preferEllipsis(line), /\.\.\./);
    assert.doesNotMatch(preferEllipsis(line), /—/);
  });

  it("AirPods and jet ski substitutes stay offer-preserving with no em dash", () => {
    for (const [line, offer] of [
      [
        "{I've got|I have} {an extra|a spare} pair of Air Pods {for you|with your name on them}.",
        /Air\s*Pods/i,
      ],
      ["I've got a jet ski you can take out this weekend.", /jet\s*ski/i],
    ] as const) {
      const swap = suggestedCopySwap(line);
      assert.match(swap, offer);
      assert.doesNotMatch(swap, /Quick note|pen-test|school-district|—/);
    }
  });

  it("first notify refreshes a swap_copy before Slack", async () => {
    const store = tempStore();
    const notified: Array<{ suggestedSwap?: string }> = [];
    const slack = {
      notifyIsolationAction: async (details: { suggestedSwap?: string }) => {
        notified.push(details);
      },
    } as unknown as SlackClient;
    const posted = await requestIsolationAction({
      store,
      slack,
      action: buildIsolationAction({
        kind: "swap_copy",
        title: "It was AirPods",
        proof: "Suggested edit: *Quick note —*.",
        detail: {
          campaignName: "TechEvo AirPods",
          element:
            "{I've got|I have} {an extra|a spare} pair of Air Pods {for you|with your name on them}.",
          swap: "Quick note —",
        },
      }),
    });
    assert.ok(posted);
    assert.match(String(posted?.detail.swap), /Air\s*Pods/i);
    assert.match(notified[0]?.suggestedSwap ?? "", /Air\s*Pods/i);
    assert.doesNotMatch(notified[0]?.suggestedSwap ?? "", /Quick note/);
  });
});
