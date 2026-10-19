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
    const store = await readFile(new URL("../state/store.ts", import.meta.url), "utf8");
    const inventory = await readFile(
      new URL("../lib/podOwnedInventory.ts", import.meta.url),
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
    assert.match(
      decisions,
      /## D288 — /,
      stop("The ledger records D288.", "DECISIONS.md has no D288 entry."),
    );
    assert.match(
      decisions,
      /^\| D288 \|/m,
      stop("The status index lists D288 (D127).", "DECISIONS.md status index has no D288 row."),
    );
    assert.match(
      canon,
      /saveHot[\s\S]{0,120}goneIds/,
      stop("CANON names slim saveHot (D288).", "CANON.md lost saveHot goneIds-only."),
    );
    assert.doesNotMatch(
      store,
      /placementScores:\s*this\.state\.isolation\.placementScores/,
      stop(
        "saveHot never embeds isolation maps (D288).",
        "store.ts hotStamps still copies placementScores.",
      ),
    );
    assert.match(
      store,
      /saveHotWanted/,
      stop("Overlapping saveHot coalesces (D288).", "store.ts lost saveHot coalescing."),
    );
    assert.doesNotMatch(
      inventory,
      /if \(isInsightJoshAllowedSender\(input\.account\)\) \{\s*return INSIGHT_CLIENT_ID;/,
      stop(
        "D288 unlinked salesglider* remap is retired (D291).",
        "podOwnedInventory.ts still remaps every Josh sender to Insight.",
      ),
    );
    assert.match(
      inventory,
      /isInsightNamedSendingDomain/,
      stop(
        "Insight-named domains remap to Insight (D291).",
        "podOwnedInventory.ts lost isInsightNamedSendingDomain.",
      ),
    );
    assert.match(
      inventory,
      /seatSitsOnInsightJoshCampaign/,
      stop(
        "Leftover Insight-campaign Josh seats still remap (D287/D291).",
        "podOwnedInventory.ts lost seatSitsOnInsightJoshCampaign.",
      ),
    );
    assert.match(
      min40,
      /if \(scanned % MIN40_SEAT_YIELD_EVERY === 0\) await yieldEventLoop\(\);/,
      stop(
        "min40 branded-warming walk yields (D288).",
        "min40TopUp.ts warmingBrandedSeats lost its yield.",
      ),
    );
    const freeze = await readFile(
      new URL("../lib/freezeWatchdog.ts", import.meta.url),
      "utf8",
    );
    const yielding = await readFile(
      new URL("../lib/stringifyYielding.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      inventory,
      /export async function countOwnedClientPods/,
      stop(
        "Owned-count yields (D289).",
        "podOwnedInventory.ts countOwnedClientPods is no longer async.",
      ),
    );
    assert.match(
      inventory,
      /scan:countOwnedClientPods/,
      stop(
        "Owned-count is a named stall op (D289).",
        "podOwnedInventory.ts lost scan:countOwnedClientPods.",
      ),
    );
    assert.match(
      inventory,
      /createLoopYielder/,
      stop(
        "Owned-count time-slices every account (D289).",
        "podOwnedInventory.ts lost createLoopYielder.",
      ),
    );
    assert.match(
      seeder,
      /warmingSeatsByClientPod/,
      stop(
        "Covering relink indexes warming seats once (D289).",
        "genericPoolCanon.ts lost warmingSeatsByClientPod.",
      ),
    );
    assert.match(
      yielding,
      /export function createLoopYielder/,
      stop("Loop yielder exists (D289).", "stringifyYielding.ts lost createLoopYielder."),
    );
    assert.match(
      freeze,
      /EVENT_LOOP_REPEAT_MS = 3_000/,
      stop(
        "Watchdog 3s repeat stays (D289).",
        "freezeWatchdog.ts widened EVENT_LOOP_REPEAT_MS.",
      ),
    );
    assert.match(
      freeze,
      /EVENT_LOOP_REPEAT_COUNT = 3/,
      stop(
        "Watchdog 3-strikes stays (D289).",
        "freezeWatchdog.ts widened EVENT_LOOP_REPEAT_COUNT.",
      ),
    );
    assert.match(
      decisions,
      /## D289 — /,
      stop("The ledger records D289.", "DECISIONS.md has no D289 entry."),
    );
    assert.match(
      decisions,
      /^\| D289 \|/m,
      stop("The status index lists D289 (D127).", "DECISIONS.md status index has no D289 row."),
    );
    assert.match(
      canon,
      /514-campaign × 1690-account/,
      stop("CANON names the fleet-size min40 yield (D289).", "CANON.md lost the 514×1690 yield rule."),
    );
    assert.match(
      decisions,
      /## D290 — /,
      stop("The ledger records D290.", "DECISIONS.md has no D290 entry."),
    );
    assert.match(
      decisions,
      /^\| D290 \|/m,
      stop("The status index lists D290 (D127).", "DECISIONS.md status index has no D290 row."),
    );
    assert.match(
      canon,
      /Joshua Osborn/,
      stop("CANON names production Insight from-name (D290).", "CANON.md lost Joshua Osborn."),
    );
    assert.match(
      canon,
      /122 free still warming/,
      stop(
        "CANON records the empty warm pool (D290).",
        "CANON.md lost the 122-free-still-warming rule.",
      ),
    );
    assert.match(
      canon,
      /Never assign unwarmed generics/,
      stop(
        "CANON forbids assigning unwarmed generics (D290).",
        "CANON.md lost the never-assign-unwarmed rule.",
      ),
    );
    const insight = await readFile(
      new URL("../lib/insightCampaigns.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      insight,
      /INSIGHT_JOSH_FROM_NAME = \/\^josh\(ua\)\?\\s\+osborn\$\/i/,
      stop(
        "Insight matcher accepts Joshua Osborn (D290).",
        "insightCampaigns.ts lost the Joshua from-name regex.",
      ),
    );
    assert.match(
      decisions,
      /## D291 — /,
      stop("The ledger records D291.", "DECISIONS.md has no D291 entry."),
    );
    assert.match(
      decisions,
      /^\| D291 \|/m,
      stop("The status index lists D291 (D127).", "DECISIONS.md status index has no D291 row."),
    );
    assert.match(
      canon,
      /SalesGlider's own/,
      stop(
        "CANON keeps SalesGlider's own salesglider* Josh seats (D291).",
        "CANON.md lost the SalesGlider salesglider* owned-count split.",
      ),
    );
    assert.match(
      canon,
      /never Insight/,
      stop(
        "CANON forbids counting SG salesglider* Josh as Insight (D291).",
        "CANON.md lost never-Insight for SalesGlider's own Josh seats.",
      ),
    );
    assert.match(
      insight,
      /export function isInsightNamedSendingDomain/,
      stop(
        "Insight-named domain helper exists (D291).",
        "insightCampaigns.ts lost isInsightNamedSendingDomain.",
      ),
    );
  });
});
