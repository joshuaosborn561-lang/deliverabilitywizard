import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SWAP_EDIT_CALLBACK_ID,
  swapEditModalView,
  swapTextFromViewSubmission,
} from "./slackSwapEdit.js";

describe("slackSwapEdit — D153 write your own edit", () => {
  it("modal shows the exact phrase being replaced before the input", () => {
    const view = swapEditModalView({
      actionId: "swap_copy-1",
      element:
        "{I've got|I have} {an extra|a spare} pair of Air Pods {for you|with your name on them}.",
      suggestedSwap: "Quick note from our pen-test work.",
      campaignName: "Goliath Education Receipts - Large Public",
    });
    assert.equal(view.callback_id, SWAP_EDIT_CALLBACK_ID);
    assert.equal(view.private_metadata, "swap_copy-1");
    const blob = JSON.stringify(view);
    assert.match(blob, /Replacing this exact phrase\/word/);
    assert.match(blob, /Air Pods/);
    assert.match(blob, /Quick note from our pen-test work/);
    assert.match(blob, /Goliath Education Receipts/);
  });

  it("reads the typed replacement from the view submission", () => {
    assert.equal(
      swapTextFromViewSubmission({
        state: {
          values: {
            swap_edit_block: {
              swap_text: { value: "Had something useful from pen testing." },
            },
          },
        },
      }),
      "Had something useful from pen testing.",
    );
    assert.equal(
      swapTextFromViewSubmission({
        state: {
          values: {
            swap_edit_block: { swap_text: { value: "" } },
          },
        },
      }),
      "",
      "blank means delete",
    );
  });
});
