import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flattenSpintax, plainProseSubstitute } from "./isolationActions.js";
import { swapCopySlackBody } from "./swapCopyCard.js";

describe("swap_copy Slack card — REMOVE / REPLACE WITH", () => {
  it("puts fenced REMOVE and WITH under the campaign name, before proof leftover", () => {
    const text = swapCopySlackBody({
      title: "It was Air Pods on TechEvo AirPods",
      campaignName: "TechEvo AirPods",
      element:
        "{I've got|I have} {an extra|a spare} pair of Air Pods {for you|with your name on them}.",
      suggestedSwap: "{I'd like to offer|Happy to offer} a pair of AirPods if useful.",
      proof: [
        "Campaign: *TechEvo AirPods*.",
        "Suggested edit: *Quick note —*.",
        "Use suggested edit, or Write my own edit to type a different replacement.",
        "Known-good email from the same inboxes landed... this is the copy, not dead inboxes. I have not edited the live email.",
      ].join("\n"),
    });
    const removeAt = text.indexOf("*REMOVE this exact text:*");
    const withAt = text.indexOf("*REPLACE WITH:*");
    const leftoverAt = text.indexOf("Known-good email");
    assert.ok(removeAt > 0);
    assert.ok(withAt > removeAt);
    assert.ok(leftoverAt > withAt);
    assert.match(text, /^\*TechEvo AirPods\*/);
    assert.match(
      text,
      /\*REMOVE this exact text:\*\n```[\s\S]*Air Pods[\s\S]*```/,
    );
    assert.match(
      text,
      /\*REPLACE WITH:\*\n```\{I'd like to offer\|Happy to offer\} a pair of AirPods if useful\.```/,
    );
    assert.doesNotMatch(text, /\*Suggested edit:\*/);
    assert.doesNotMatch(text, /Quick note/);
    assert.doesNotMatch(text, /—/);
    assert.match(text, /Use suggested edit/);
  });

  it("blank swap fences the delete label with ellipsis, not an em dash", () => {
    const text = swapCopySlackBody({
      title: "It was winner",
      campaignName: "TechEvo",
      element: "winner",
      suggestedSwap: "",
      proof: "Campaign: *TechEvo*.",
    });
    assert.match(text, /\*REPLACE WITH:\*\n```\(delete that phrase\.\.\. leave nothing\)```/);
    assert.doesNotMatch(text, /—/);
  });

  it("flattens single-line WITH spintax into plain prose", () => {
    assert.equal(
      flattenSpintax("{Happy to send|I can send} a pair of AirPods"),
      "Happy to send a pair of AirPods",
    );
    const text = swapCopySlackBody({
      title: "swap",
      campaignName: "TechEvo",
      element: "I've got Air Pods for you.",
      suggestedSwap: "{Happy to send|I can send} a pair of AirPods if useful.",
      proof: "",
    });
    assert.match(text, /```Happy to send a pair of AirPods if useful\.```/);
    assert.doesNotMatch(text, /\{Happy to send\|I can send\}/);
  });

  it("keeps D171 I'd-like-to-offer lead-in on REPLACE WITH", () => {
    const swap = "{I'd like to offer|Happy to offer} a pair of AirPods if useful.";
    const text = swapCopySlackBody({
      title: "swap",
      campaignName: "TechEvo",
      element: "I've got Air Pods for you.",
      suggestedSwap: swap,
      proof: "",
    });
    assert.match(
      text,
      /```\{I'd like to offer\|Happy to offer\} a pair of AirPods if useful\.```/,
    );
    assert.doesNotMatch(text, /—/);
  });

  it("keeps matching multi-group spintax when the find is also spintax", () => {
    const find = "{Hey|Hi} {there|friend}";
    const swap = "{Hello|Howdy} {there|friend}";
    assert.equal(plainProseSubstitute(find, swap), swap);
  });
});
