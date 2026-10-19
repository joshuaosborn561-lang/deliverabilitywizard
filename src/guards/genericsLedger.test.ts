import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { GENERIC_LEDGER_CORE_KINDS, GENERIC_POOL_CORE_KINDS } from "../lib/genericPool.js";
import { CANON_CORE_KINDS } from "../lib/canonCompliance.js";
import { LOCKED_GENERICS_LEDGER_RULE } from "../lib/lockedCanon.js";

function stop(decision: string, problem: string): string {
  return [
    "",
    "STOP — this reverses one of Josh's decisions.",
    `  Decision: ${decision}`,
    `  Problem:  ${problem}`,
    "This is not a bug. See DECISIONS.md for the reasoning and the tradeoff.",
    "Check with Josh before changing it. Do not delete this guard to go green.",
    "",
  ].join("\n");
}

describe("owner intent — D286 Generics Ledger", () => {
  it("ledger fields, findings, and locked sentence stay wired", async () => {
    const pool = await readFile(new URL("../lib/genericPool.ts", import.meta.url), "utf8");
    const seeder = await readFile(
      new URL("../lib/genericPoolCanon.ts", import.meta.url),
      "utf8",
    );
    const surplus = await readFile(
      new URL("../lib/genericSurplusReturn.ts", import.meta.url),
      "utf8",
    );
    const surplusApply = await readFile(
      new URL("../services/genericSurplusReturn.ts", import.meta.url),
      "utf8",
    );
    const cleanup = await readFile(
      new URL("../lib/genericLedgerCleanup.ts", import.meta.url),
      "utf8",
    );
    const canon = await readFile(new URL("../../CANON.md", import.meta.url), "utf8");
    const decisions = await readFile(
      new URL("../../DECISIONS.md", import.meta.url),
      "utf8",
    );
    const min40 = await readFile(
      new URL("../services/min40TopUp.ts", import.meta.url),
      "utf8",
    );

    assert.match(
      pool,
      /warmupEnabled/,
      stop("Ledger rows carry warmup on/off (D286).", "genericPool.ts lost warmupEnabled."),
    );
    assert.match(
      pool,
      /coveringFor/,
      stop("Ledger rows carry covering_for (D286).", "genericPool.ts lost coveringFor."),
    );
    assert.match(
      seeder,
      /mailboxWarmupIsOn/,
      stop("Seeder fills warmup from Smartlead (D286).", "genericPoolCanon.ts lost mailboxWarmupIsOn."),
    );
    assert.match(
      seeder,
      /linkCoveringFor/,
      stop("Seeder links covering_for (D286).", "genericPoolCanon.ts lost linkCoveringFor."),
    );
    assert.match(
      surplus,
      /pickCoveringForReturns/,
      stop("Named-warm swap is per-seat (D286).", "genericSurplusReturn.ts lost pickCoveringForReturns."),
    );
    assert.match(
      surplusApply,
      /STOPPED/,
      stop("Never touch STOPPED (D286).", "services/genericSurplusReturn.ts lost the STOPPED skip."),
    );
    assert.match(
      cleanup,
      /runGenericLedgerCleanup/,
      stop("One-time cleanup exists (D286).", "genericLedgerCleanup.ts lost the runner."),
    );
    assert.doesNotMatch(
      cleanup,
      /updateCampaignStatus/,
      stop(
        "Cleanup never START/PAUSE (D286).",
        "genericLedgerCleanup.ts gained a campaign status write.",
      ),
    );
    assert.doesNotMatch(
      cleanup,
      /status:\s*["'](?:START|PAUSED|STOPPED)["']/,
      stop(
        "Cleanup never START/PAUSE (D286).",
        "genericLedgerCleanup.ts writes a campaign status.",
      ),
    );
    for (const kind of GENERIC_LEDGER_CORE_KINDS) {
      assert.ok(
        (GENERIC_POOL_CORE_KINDS as readonly string[]).includes(kind),
        stop(`Finding ${kind} is a pool core kind (D286).`, "GENERIC_POOL_CORE_KINDS dropped it."),
      );
      assert.ok(
        (CANON_CORE_KINDS as readonly string[]).includes(kind),
        stop(`Finding ${kind} flips /health (D286).`, "CANON_CORE_KINDS dropped it."),
      );
    }
    assert.ok(
      canon.includes(LOCKED_GENERICS_LEDGER_RULE),
      stop("LOCKED Generics Ledger sentence (D286).", "CANON.md lost the exact sentence."),
    );
    assert.match(
      decisions,
      /## D286 — /,
      stop("The ledger records D286.", "DECISIONS.md has no D286 entry."),
    );
    assert.match(
      decisions,
      /^\| D286 \|/m,
      stop("The status index lists D286 (D127).", "DECISIONS.md status index has no D286 row."),
    );
    assert.match(
      min40,
      /pickFreeWarmGenericsForPod/,
      stop(
        "min40 assigns from the ledger (D287).",
        "min40TopUp.ts lost pickFreeWarmGenericsForPod.",
      ),
    );
    assert.match(
      min40,
      /suppressPodFloorAlert/,
      stop(
        "Peterson under-floor alerts stay suppressed (D287).",
        "min40TopUp.ts lost suppressPodFloorAlert.",
      ),
    );
    assert.match(
      decisions,
      /## D287 — /,
      stop("The ledger records D287.", "DECISIONS.md has no D287 entry."),
    );
    assert.match(
      decisions,
      /^\| D287 \|/m,
      stop("The status index lists D287 (D127).", "DECISIONS.md status index has no D287 row."),
    );
  });
});
