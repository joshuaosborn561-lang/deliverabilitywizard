import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GOLIATH_CLIENT_ID,
  isPocClient,
  isPocClientId,
  pocClientId,
  POC_CLIENT_IDS,
} from "./pocClient.js";
import { POWERGRYD_CLIENT_ID } from "./powerGryd.js";

describe("POC set (D81 / D204)", () => {
  it("enumerates Goliath and PowerGryd", () => {
    assert.deepEqual(POC_CLIENT_IDS, [GOLIATH_CLIENT_ID, POWERGRYD_CLIENT_ID]);
    assert.equal(isPocClientId(548611), true);
    assert.equal(isPocClientId(592842), true);
    assert.equal(isPocClientId(542838), false);
  });

  it("matches PowerGryd hay even when patterns are goliath-only", () => {
    assert.equal(isPocClient("PowerGRYD MSP", ["goliath"]), true);
    assert.equal(isPocClient("Goliath Displacement", ["goliath"]), true);
    assert.equal(isPocClient("TechEvolution", ["goliath"]), false);
  });

  it("rotating-pool owner stays Goliath when PowerGryd is also present", () => {
    assert.equal(
      pocClientId(
        [
          { id: 592842, name: "Jesse Miller", logo: "PowerGRYD" },
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        ],
        ["goliath", "powergryd"],
      ),
      548611,
    );
    assert.equal(
      pocClientId(
        [{ id: 592842, name: "Jesse Miller", logo: "PowerGRYD" }],
        ["goliath", "powergryd"],
      ),
      null,
      "PowerGryd must not become genericOwnerId",
    );
  });
});
