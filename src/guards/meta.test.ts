import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

/**
 * D127 — the ledger cannot fork and the canon cannot rot.
 *
 * These guards exist because two PRs once claimed the same decision number
 * (both #135 and #137 appended a "D124"), and because the one-page CANON.md
 * is only trustworthy if it is impossible to land a decision without
 * updating it.
 */

const ledgerUrl = new URL("../../DECISIONS.md", import.meta.url);
const canonUrl = new URL("../../CANON.md", import.meta.url);

const ENTRY_HEADER = /^## D(\d+) — /gm;

async function ledgerNumbers(): Promise<number[]> {
  const ledger = await readFile(ledgerUrl, "utf8");
  return [...ledger.matchAll(ENTRY_HEADER)].map((m) => Number(m[1]));
}

describe("meta — decision ledger integrity (D127)", () => {
  it("every decision number is unique", async () => {
    const numbers = await ledgerNumbers();
    const seen = new Map<number, number>();
    for (const n of numbers) seen.set(n, (seen.get(n) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => `D${n}`);
    assert.deepEqual(
      dupes,
      [],
      `DECISIONS.md has duplicate decision headers: ${dupes.join(", ")}. ` +
        `Two branches claimed the same number — renumber the newer entry ` +
        `(take the next free number across main AND open PRs; D127).`,
    );
  });

  it("CANON.md names the newest decision", async () => {
    const numbers = await ledgerNumbers();
    const max = Math.max(...numbers);
    const canon = await readFile(canonUrl, "utf8");
    assert.match(
      canon,
      new RegExp(`Canon as of \\*\\*D${max}\\*\\*`),
      `CANON.md must say "Canon as of **D${max}**". A decision landed ` +
        `without updating the canon — fold D${max} into CANON.md in this ` +
        `same PR (D127).`,
    );
  });

  it("the status index covers the newest decision", async () => {
    const numbers = await ledgerNumbers();
    const max = Math.max(...numbers);
    const ledger = await readFile(ledgerUrl, "utf8");
    assert.match(
      ledger,
      new RegExp(`^\\| D${max} \\|`, "m"),
      `The DECISIONS.md status index has no row for D${max}. Add its ` +
        `status line when appending the entry (D127).`,
    );
  });
});
