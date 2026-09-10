import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canDecideIsolationAction, slackRoleOf } from "./isolationActors.js";

describe("isolation actors", () => {
  it("Josh or Cayden can retire or buy cover; canary stays Josh-only (D190)", () => {
    assert.equal(slackRoleOf("U1", ["U1"], ["U2"]), "owner");
    assert.equal(slackRoleOf("U2", ["U1"], ["U2"]), "operator");
    assert.equal(canDecideIsolationAction("buy_domains", "owner"), true);
    assert.equal(canDecideIsolationAction("buy_domains", "operator"), true);
    assert.equal(canDecideIsolationAction("retire_domain", "operator"), true);
    assert.equal(canDecideIsolationAction("buy_canary_fleet", "owner"), true);
    assert.equal(canDecideIsolationAction("buy_canary_fleet", "operator"), false);
    assert.equal(canDecideIsolationAction("swap_copy", "operator"), true);
  });
});
