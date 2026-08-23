import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canDecideIsolationAction, slackRoleOf } from "./isolationActors.js";

describe("isolation actors", () => {
  it("only Josh can retire or buy; Josh or Cayden can swap copy", () => {
    assert.equal(slackRoleOf("U1", ["U1"], ["U2"]), "owner");
    assert.equal(slackRoleOf("U2", ["U1"], ["U2"]), "operator");
    assert.equal(canDecideIsolationAction("buy_domains", "owner"), true);
    assert.equal(canDecideIsolationAction("buy_domains", "operator"), false);
    assert.equal(canDecideIsolationAction("retire_domain", "operator"), false);
    assert.equal(canDecideIsolationAction("swap_copy", "operator"), true);
  });
});
