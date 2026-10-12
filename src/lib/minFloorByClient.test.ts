import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TECHEVO_CLIENT_ID } from "./autoAllowGenerics.js";
import {
  DEFAULT_MIN_FLOOR,
  DEFAULT_MIN_FLOOR_BY_CLIENT,
  minFloorForClient,
  parseMinFloorByClient,
} from "./minFloorByClient.js";

describe("D256 MIN_FLOOR_BY_CLIENT", () => {
  it("defaults TechEvo to 30 and everyone else to 40", () => {
    assert.equal(DEFAULT_MIN_FLOOR, 40);
    assert.equal(DEFAULT_MIN_FLOOR_BY_CLIENT[TECHEVO_CLIENT_ID], 30);
    assert.equal(minFloorForClient(TECHEVO_CLIENT_ID), 30);
    assert.equal(minFloorForClient(542838), 40);
    assert.equal(minFloorForClient(592842), 40);
    assert.equal(minFloorForClient(null), 40);
  });

  it("parses MIN_FLOOR_BY_CLIENT env maps", () => {
    assert.deepEqual(parseMinFloorByClient(""), { ...DEFAULT_MIN_FLOOR_BY_CLIENT });
    assert.deepEqual(parseMinFloorByClient("none"), {});
    assert.deepEqual(parseMinFloorByClient("521881:30,542838=35"), {
      521881: 30,
      542838: 35,
    });
    assert.equal(minFloorForClient(542838, parseMinFloorByClient("542838:35")), 35);
  });
});
