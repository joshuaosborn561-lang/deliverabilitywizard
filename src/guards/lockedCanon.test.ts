import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  LOCKED_CANON_APPROVAL_NOTE,
  LOCKED_CANON_HEADING,
  LOCKED_POD_40_RULE,
  LOCKED_GENERICS_LEDGER_RULE,
  extractLockedCanonSection,
  lockedCanonSectionBody,
} from "../lib/lockedCanon.js";

/**
 * D285 — POD-40 is LOCKED core canon. A failure here means someone
 * removed, narrowed, or quietly reversed Josh's locked rule.
 */

function stop(decision: string, problem: string): string {
  return [
    "",
    "STOP — this reverses one of Josh's decisions.",
    `  Decision: ${decision}`,
    `  Problem:  ${problem}`,
    "This is not a bug. See DECISIONS.md for the reasoning and the tradeoff.",
    "Check with Josh before changing it. Do not delete this guard to go green.",
    "LOCKED canon changes require Josh's explicit approval and must never auto-merge.",
    "",
  ].join("\n");
}

describe("owner intent — D285 LOCKED POD-40 canon", () => {
  it("LOCKED section is present, unaltered, and mirrored in-repo", async () => {
    const canon = await readFile(new URL("../../CANON.md", import.meta.url), "utf8");
    const docs = await readFile(
      new URL("../../docs/LOCKED-CANON.md", import.meta.url),
      "utf8",
    );
    const owners = await readFile(
      new URL("../../.github/CODEOWNERS", import.meta.url),
      "utf8",
    );
    const ci = await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const protection = await readFile(
      new URL("../../docs/BRANCH_PROTECTION.md", import.meta.url),
      "utf8",
    );
    const min40 = await readFile(
      new URL("../services/min40TopUp.ts", import.meta.url),
      "utf8",
    );
    const inventory = await readFile(
      new URL("../lib/podOwnedInventory.ts", import.meta.url),
      "utf8",
    );
    const check = await readFile(
      new URL("../services/campaignCheck.ts", import.meta.url),
      "utf8",
    );
    const audit = await readFile(
      new URL("../services/campaignAudit.ts", import.meta.url),
      "utf8",
    );
    const topUp = await readFile(
      new URL("../services/campaignTopUp.ts", import.meta.url),
      "utf8",
    );
    const decisions = await readFile(
      new URL("../../DECISIONS.md", import.meta.url),
      "utf8",
    );

    const section = extractLockedCanonSection(canon);
    assert.ok(
      section.length > 0,
      stop(
        "POD-40 is LOCKED core canon (D285).",
        "CANON.md lost the LOCKED — Josh-only changes section.",
      ),
    );
    assert.equal(
      section,
      lockedCanonSectionBody(),
      stop(
        "POD-40 is LOCKED core canon (D285).",
        "CANON.md LOCKED section was altered. Restore the exact POD-40 sentence.",
      ),
    );
    assert.match(
      canon,
      new RegExp(LOCKED_CANON_HEADING.replace(/[—]/g, "—")),
      stop(
        "POD-40 is LOCKED core canon (D285).",
        "CANON.md lost the LOCKED heading.",
      ),
    );
    assert.ok(
      canon.includes(LOCKED_POD_40_RULE),
      stop(
        "POD-40 is LOCKED core canon (D285).",
        "CANON.md lost or altered the exact POD-40 sentence.",
      ),
    );
    assert.ok(
      canon.includes(LOCKED_GENERICS_LEDGER_RULE),
      stop(
        "Generics Ledger is LOCKED core canon (D286).",
        "CANON.md lost or altered the exact Generics Ledger sentence.",
      ),
    );
    assert.ok(
      canon.includes(LOCKED_CANON_APPROVAL_NOTE),
      stop(
        "POD-40 is LOCKED core canon (D285).",
        "CANON.md lost the Josh-only / never-auto-merge note.",
      ),
    );
    assert.ok(
      docs.includes(LOCKED_POD_40_RULE),
      stop(
        "POD-40 is LOCKED core canon (D285).",
        "docs/LOCKED-CANON.md lost the exact POD-40 sentence.",
      ),
    );
    assert.ok(
      docs.includes(LOCKED_CANON_HEADING),
      stop(
        "POD-40 is LOCKED core canon (D285).",
        "docs/LOCKED-CANON.md lost the LOCKED heading.",
      ),
    );
    assert.match(
      owners,
      /\/CANON\.md @joshuaosborn561-lang/,
      stop(
        "LOCKED canon changes require Josh (D285).",
        "CODEOWNERS no longer assigns CANON.md to Josh.",
      ),
    );
    assert.match(
      owners,
      /\/docs\/LOCKED-CANON\.md @joshuaosborn561-lang/,
      stop(
        "Josh owns the canon definition files (D322).",
        "CODEOWNERS no longer assigns docs/LOCKED-CANON.md to Josh.",
      ),
    );
    assert.match(
      owners,
      /\/src\/lib\/lockedCanon\.ts @joshuaosborn561-lang/,
      stop(
        "Josh owns the canon definition files (D322).",
        "CODEOWNERS no longer assigns src/lib/lockedCanon.ts to Josh.",
      ),
    );
    assert.match(
      owners,
      /does not require Josh's review/,
      stop(
        "Canon-consistent PRs do not require Josh's review (D322).",
        "CODEOWNERS lost the canon-consistent review exception.",
      ),
    );
    assert.match(
      owners,
      /must never auto-merge/,
      stop(
        "LOCKED canon PRs must never auto-merge (D285).",
        "CODEOWNERS lost the never-auto-merge comment.",
      ),
    );
    assert.doesNotMatch(
      owners,
      /^\/src\/guards\/lockedCanon\.test\.ts\s+@joshuaosborn561-lang\s*$/m,
      stop(
        "Implementation paths are not Josh-only (D322).",
        "CODEOWNERS again requires Josh alone on src/guards/lockedCanon.test.ts.",
      ),
    );
    assert.match(
      ci,
      /locked-canon:/,
      stop(
        "LOCKED canon PRs must never auto-merge (D285).",
        "ci.yml lost the locked-canon job that blocks auto-merge.",
      ),
    );
    assert.match(
      ci,
      /src\/lib\/lockedCanonGateCli\.ts/,
      stop(
        "The locked-canon job uses the D322 gate (D322).",
        "ci.yml no longer runs lockedCanonGateCli.ts.",
      ),
    );
    assert.match(
      ci,
      /Never auto-merge/,
      stop(
        "LOCKED canon PRs must never auto-merge (D285).",
        "ci.yml locked-canon job lost the never-auto-merge fail path.",
      ),
    );
    assert.doesNotMatch(
      ci,
      /LOCKED canon section changed vs base/,
      stop(
        "Canon-consistent PRs are not a hard Josh block (D322).",
        "ci.yml still fails every LOCKED-section diff with no canon-change label.",
      ),
    );
    const gate = await readFile(
      new URL("../lib/lockedCanonGate.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      gate,
      /Canon-consistent/,
      stop(
        "Canon-consistent PRs pass without Josh (D322).",
        "lockedCanonGate.ts lost the canon-consistent pass.",
      ),
    );
    assert.match(
      gate,
      /canon-change/,
      stop(
        "Locked edits need the canon-change label (D322).",
        "lockedCanonGate.ts lost the canon-change label.",
      ),
    );
    assert.match(
      gate,
      /Never auto-merge/,
      stop(
        "Unauthorized locked edits never auto-merge (D322).",
        "lockedCanonGate.ts lost the never-auto-merge fail path.",
      ),
    );
    assert.match(
      protection,
      /never auto-merge/,
      stop(
        "LOCKED canon PRs must never auto-merge (D285).",
        "docs/BRANCH_PROTECTION.md lost the never-auto-merge rule.",
      ),
    );
    assert.match(
      protection,
      /canon-change/,
      stop(
        "Branch protection records the canon-change label (D322).",
        "docs/BRANCH_PROTECTION.md lost the canon-change rule.",
      ),
    );
    assert.match(
      protection,
      /Do \*\*not\*\* require review from Code Owners/,
      stop(
        "Code-owner review is not the merge gate (D322).",
        "docs/BRANCH_PROTECTION.md again requires code-owner review to merge.",
      ),
    );
    assert.match(
      protection,
      /\*\*`check`\*\*/,
      stop(
        "The check status stays required (D322).",
        "docs/BRANCH_PROTECTION.md dropped the check status.",
      ),
    );
    assert.match(
      protection,
      /\*\*`locked-canon`\*\*/,
      stop(
        "The locked-canon status stays required (D322).",
        "docs/BRANCH_PROTECTION.md dropped the locked-canon status.",
      ),
    );

    assert.match(
      min40,
      /named-client min-40 is POD inventory, not per campaign/,
      stop(
        "Min-40 is per POD, never per campaign (D285).",
        "min40TopUp.ts reintroduced a named per-campaign fill walk.",
      ),
    );
    assert.match(
      min40,
      /Never skip the off-week POD/,
      stop(
        "Never skip the off-week POD (D285).",
        "min40TopUp.ts lost the both-POD fill rule.",
      ),
    );
    assert.match(
      min40,
      /for \(const pod of pods\)/,
      stop(
        "Min-40 counts both PODs (D285).",
        "fillShortPods no longer walks both POD A and POD B.",
      ),
    );
    assert.doesNotMatch(
      min40,
      /if \(pod !== onWeek\) continue/,
      stop(
        "Never skip the off-week POD (D285).",
        "fillShortPods reintroduced the D268 off-week skip.",
      ),
    );
    assert.match(
      min40,
      /countOwnedClientPods/,
      stop(
        "Min-40 counts owned inventory per POD (D285).",
        "min40TopUp.ts stopped using countOwnedClientPods.",
      ),
    );
    assert.match(
      inventory,
      /for \(const pod of \["A", "B"\] as const\)/,
      stop(
        "Min-40 counts both PODs (D285).",
        "countOwnedClientPods no longer walks POD A and POD B.",
      ),
    );
    assert.match(
      inventory,
      /seatSitsOnForeignNamedCampaign/,
      stop(
        "Borrowed seats never count (D285).",
        "podOwnedInventory.ts lost the borrowed-seat skip.",
      ),
    );
    assert.match(
      check,
      /named min-40 is POD inventory, never per campaign/,
      stop(
        "Campaign-check must not count named min-40 per campaign (D285).",
        "campaignCheck.ts lost the POD inventory understaffed path.",
      ),
    );
    assert.match(
      check,
      /applyNamedPodUnderstaffed/,
      stop(
        "Campaign-check applies POD understaffed (D285).",
        "campaignCheck.ts lost applyNamedPodUnderstaffed.",
      ),
    );
    assert.match(
      audit,
      /named min-40 is POD inventory, never per campaign/,
      stop(
        "Campaign-audit must not count named min-40 per campaign (D285).",
        "campaignAudit.ts lost the named shortBy 0 / POD inventory path.",
      ),
    );
    assert.match(
      audit,
      /podUnderstaffed/,
      stop(
        "Campaign-audit reports POD understaffed (D285).",
        "campaignAudit.ts lost podUnderstaffed.",
      ),
    );
    assert.match(
      topUp,
      /named min-40 is POD inventory/,
      stop(
        "Campaign-top-up must not fill named min-40 per campaign (D285).",
        "campaignTopUp.ts lost the named skip.",
      ),
    );
    assert.match(
      decisions,
      /## D285 — /,
      stop("The ledger records D285.", "DECISIONS.md has no D285 entry."),
    );
    assert.match(
      decisions,
      /^\| D285 \|/m,
      stop("The status index lists D285 (D127).", "DECISIONS.md status index has no D285 row."),
    );
    assert.match(
      canon,
      /Canon as of \*\*D(286|28[7-9]|29[0-9]|3[0-9]{2})\*\*/,
      stop("CANON is dated D286+.", "CANON.md header is before D286."),
    );
  });
});
