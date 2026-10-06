import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANARY_LOCK_CORE_KINDS,
  GABE_VM_RESERVED_TAG,
  gabeVmReservedCampaignIds,
  isCanarySignature,
  isGabeVmReserved,
  isLockedCanarySeat,
  validateCanaryLock,
} from "./canaryLock.js";
import { CANON_CORE_KINDS } from "./canonCompliance.js";

describe("D238 canary hard lock", () => {
  it("recognises the Canary signature backstop and fleet membership", () => {
    assert.equal(isCanarySignature("Leila Sanchez\nCanary"), true);
    assert.equal(isCanarySignature("Harmony Norris\nDeep Roots Capital"), false);
    assert.equal(
      isLockedCanarySeat(
        { signature: "Ada Lovelace\nCanary" },
        "ada@newcanary.test",
      ),
      true,
    );
    assert.equal(
      isLockedCanarySeat(
        { signature: "" },
        "ada@newcanary.test",
        { isCopyCanary: (email) => email === "ada@newcanary.test" },
      ),
      true,
    );
    assert.equal(
      isLockedCanarySeat(
        { tags: [{ tag_name: "CANARY" }] },
        "ada@newcanary.test",
      ),
      true,
    );
    assert.equal(
      isLockedCanarySeat(
        { signature: "Leila Sanchez\nCanary" },
        "leilasanchez@getcrosslaunchco.info",
      ),
      false,
      "released 2026-10-05 seats are not canaries for D238",
    );
    assert.equal(
      isLockedCanarySeat(
        { signature: "Ada Lovelace\nTechEvolution" },
        "ada@techevolution.com",
      ),
      false,
    );
  });

  it("pages when a canary is on a live campaign or warmup is on", () => {
    const findings = validateCanaryLock({
      accounts: [
        {
          from_email: "ada@newcanary.test",
          signature: "Ada Lovelace\nCanary",
          warmup_details: { status: "ACTIVE" },
          campaign_ids: [3847798, 1],
        },
      ],
      campaigns: [
        { id: 3847798, name: "TechEvo A", status: "ACTIVE" },
        { id: 1, name: "Canary shell: #99 TechEvo A" },
      ],
    });
    assert.equal(
      findings.some((row) => row.kind === "canary_warmup_on"),
      true,
    );
    assert.equal(
      findings.some(
        (row) =>
          row.kind === "canary_on_live" && row.detail.includes("3847798"),
      ),
      true,
    );
    assert.equal(
      findings.some((row) => row.detail.includes("#1")),
      false,
      "canary shell membership is allowed",
    );
  });

  it("D240: a released contaminated seat does not page warmup-on or live-link", () => {
    const findings = validateCanaryLock({
      accounts: [
        {
          from_email: "leilasanchez@getcrosslaunchco.info",
          signature: "Leila Sanchez\nCanary",
          warmup_details: { status: "ACTIVE" },
          campaign_ids: [3847798],
        },
      ],
      campaigns: [{ id: 3847798, name: "TechEvo A", status: "ACTIVE" }],
    });
    assert.equal(findings.length, 0);
  });

  it("core kinds flip /health", () => {
    for (const kind of CANARY_LOCK_CORE_KINDS) {
      assert.ok((CANON_CORE_KINDS as readonly string[]).includes(kind));
    }
  });
});

describe("D239 GABE-VM-RESERVED is not named inventory", () => {
  it("reads the reserved tag", () => {
    assert.equal(
      isGabeVmReserved({ tags: [{ tag_name: GABE_VM_RESERVED_TAG }] }),
      true,
    );
    assert.equal(isGabeVmReserved({ tags: [{ tag_name: "POD-A" }] }), false);
  });

  it("D241: lists campaigns already linked to a reserved seat", () => {
    assert.deepEqual(
      gabeVmReservedCampaignIds([
        {
          tags: [{ tag_name: GABE_VM_RESERVED_TAG }],
          campaign_ids: [4074266, 4085160],
        },
        { tags: [{ tag_name: "POD-A" }], campaign_ids: [10] },
      ]).sort((a, b) => a - b),
      [4074266, 4085160],
    );
  });
});
