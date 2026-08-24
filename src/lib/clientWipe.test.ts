import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  nameHayMatches,
  pickKeepByMix,
  VASCO_KEEP_COUNT,
} from "./clientWipe.js";

describe("pickKeepByMix", () => {
  it("keeps 40 with the same Google / Microsoft mix (D61)", () => {
    const rows = [
      ...Array.from({ length: 50 }, (_, i) => ({
        email: `g${String(i).padStart(2, "0")}@vasco.com`,
        esp: "GOOGLE" as const,
        on: i < 25,
      })),
      ...Array.from({ length: 30 }, (_, i) => ({
        email: `m${String(i).padStart(2, "0")}@vasco.com`,
        esp: "MICROSOFT" as const,
        on: i < 15,
      })),
    ];
    const keep = pickKeepByMix(rows, VASCO_KEEP_COUNT, {
      esp: (row) => row.esp,
      prefer: (row) => row.on,
      key: (row) => row.email,
    });
    assert.equal(keep.length, 40);
    assert.equal(keep.filter((row) => row.esp === "GOOGLE").length, 25);
    assert.equal(keep.filter((row) => row.esp === "MICROSOFT").length, 15);
    assert.equal(keep.filter((row) => row.on).length, 40);
  });

  it("returns everyone when already at or under the cap", () => {
    const rows = [
      { email: "a@x.com", esp: "GOOGLE" as const, on: true },
      { email: "b@x.com", esp: "MICROSOFT" as const, on: false },
    ];
    assert.equal(
      pickKeepByMix(rows, 40, {
        esp: (row) => row.esp,
        prefer: (row) => row.on,
        key: (row) => row.email,
      }).length,
      2,
    );
  });
});

describe("nameHayMatches", () => {
  it("matches GXA / MSRS / Nieto / Vasco without hitting other clients", () => {
    assert.equal(nameHayMatches("GXA Outreach", ["gxa", "msrs", "nieto"]), true);
    assert.equal(nameHayMatches("MSRS2 Ticket Offer", ["gxa", "msrs", "nieto"]), true);
    assert.equal(nameHayMatches("Nieto Roofing", ["gxa", "msrs", "nieto"]), true);
    assert.equal(nameHayMatches("Vasco Warranty", ["vasco"]), true);
    assert.equal(nameHayMatches("Parlay", ["gxa", "msrs", "nieto", "vasco"]), false);
    assert.equal(nameHayMatches("Goliath Displacement", ["gxa"]), false);
  });
});
