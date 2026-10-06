import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANARY_LOCK_CORE_KINDS,
  GABE_VM_RESERVED_TAG,
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
        { signature: "Leila Sanchez\nCanary" },
        "leilasanchez@getcrosslaunchco.info",
      ),
      true,
    );
    assert.equal(
      isLockedCanarySeat(
        { signature: "" },
        "leilasanchez@getcrosslaunchco.info",
        { isCopyCanary: (email) => email === "leilasanchez@getcrosslaunchco.info" },
      ),
      true,
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
          from_email: "leilasanchez@getcrosslaunchco.info",
          signature: "Leila Sanchez\nCanary",
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
});
