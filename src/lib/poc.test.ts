import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPocHay, pocHayForAccount, pocStaffPatterns } from "./poc.js";

describe("poc", () => {
  it("matches Goliath as a POC client (D70)", () => {
    assert.equal(isPocHay("Goliath Displacement L", ["goliath"]), true);
    assert.equal(isPocHay("Dave Ackley", ["goliath"]), false);
    assert.equal(isPocHay("BCP Healthcare Over-1k", ["goliath"]), false);
  });

  it("merges generic-staff and POC patterns", () => {
    assert.deepEqual(pocStaffPatterns(["goliath"], ["goliath", "acme"]), [
      "goliath",
      "acme",
    ]);
  });

  it("keeps a sitting Goliath generic identifiable from client_id (D70)", () => {
    const hay = pocHayForAccount(
      { client_id: 11 },
      "spare@crosslaunchco.com",
      [],
      [{ id: 80, name: "Goliath Displacement L", client_id: 11 }],
      [{ id: 11, name: "Dave Ackley" }],
    );
    assert.equal(isPocHay(hay, ["goliath"]), true);
  });
});
