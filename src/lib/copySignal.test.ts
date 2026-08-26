import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allEspsAtOrAbove, anyEspBelowThreshold } from "./copySignal.js";

describe("copySignal (D93/D96 readings)", () => {
  it("flags any ESP below the threshold", () => {
    assert.equal(
      anyEspBelowThreshold([
        { name: "G Suite", inboxPercent: 100 },
        { name: "Office365", inboxPercent: 40 },
      ]),
      true,
    );
    assert.equal(
      anyEspBelowThreshold([
        { name: "G Suite", inboxPercent: 95 },
        { name: "Office365", inboxPercent: 88 },
      ]),
      false,
    );
  });

  it("all-clear needs every scored ESP at or above; empty is unknown", () => {
    assert.equal(
      allEspsAtOrAbove([
        { name: "G Suite", inboxPercent: 95 },
        { name: "Office365", inboxPercent: 88 },
      ]),
      true,
    );
    assert.equal(
      allEspsAtOrAbove([
        { name: "G Suite", inboxPercent: 95 },
        { name: "Office365", inboxPercent: 20 },
      ]),
      false,
    );
    assert.equal(allEspsAtOrAbove([]), null);
  });
});
