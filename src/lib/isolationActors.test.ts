import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canDecideIsolationAction,
  isHumanCopySwapActor,
  slackRoleOf,
} from "./isolationActors.js";

describe("isolation actors", () => {
  it("only Josh can retire or buy; Josh or Cayden can swap copy", () => {
    assert.equal(slackRoleOf("U1", ["U1"], ["U2"]), "owner");
    assert.equal(slackRoleOf("U2", ["U1"], ["U2"]), "operator");
    assert.equal(canDecideIsolationAction("buy_domains", "owner"), true);
    assert.equal(canDecideIsolationAction("buy_domains", "operator"), false);
    assert.equal(canDecideIsolationAction("buy_canary_fleet", "owner"), true);
    assert.equal(canDecideIsolationAction("buy_canary_fleet", "operator"), false);
    assert.equal(canDecideIsolationAction("retire_domain", "operator"), false);
    assert.equal(canDecideIsolationAction("swap_copy", "operator"), true);
  });

  it("D188: system / digest / empty names are not a word-edit tap", () => {
    assert.equal(
      isHumanCopySwapActor({ name: "Josh", role: "owner" }),
      true,
    );
    assert.equal(
      isHumanCopySwapActor({ name: "Cayden", role: "operator" }),
      true,
    );
    assert.equal(
      isHumanCopySwapActor({ name: "system", role: "owner" }),
      false,
    );
    assert.equal(
      isHumanCopySwapActor({ name: "digest", role: "owner" }),
      false,
    );
    assert.equal(
      isHumanCopySwapActor({ name: "wizard", role: "operator" }),
      false,
    );
    assert.equal(isHumanCopySwapActor({ name: "", role: "owner" }), false);
    assert.equal(
      isHumanCopySwapActor({ name: "Josh", role: "unknown" }),
      false,
    );
  });
});
