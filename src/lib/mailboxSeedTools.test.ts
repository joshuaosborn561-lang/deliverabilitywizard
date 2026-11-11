import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MAILBOX_OWNER_SEED } from "../data/mailboxOwnerSeed.js";
import {
  assertSeedDoesNotShrink,
  mergeSeedRows,
  renderSeedJson,
  renderSeedModule,
  seedRowsFromBackup,
} from "./mailboxSeedTools.js";

describe("D332 mailbox seed tools", () => {
  it("re-renders the committed seed byte-for-byte (module and JSON)", () => {
    assert.equal(
      renderSeedModule(MAILBOX_OWNER_SEED),
      readFileSync(new URL("../data/mailboxOwnerSeed.ts", import.meta.url), "utf8"),
    );
    assert.equal(
      renderSeedJson(MAILBOX_OWNER_SEED),
      readFileSync(new URL("../../data/mailbox-owner-seed.json", import.meta.url), "utf8"),
    );
  });

  it("a post-deletion backup (client_id null) yields no rows and the shrink guard refuses it", () => {
    const { rows } = seedRowsFromBackup(MAILBOX_OWNER_SEED.map((r) => ({ id: r.id, from_email: r.from_email, client_id: null })));
    assert.equal(rows.length, 0);
    assert.throws(() => assertSeedDoesNotShrink(rows, MAILBOX_OWNER_SEED), /refusing to write 0 seed rows/);
  });

  it("maps JEREMY-CIOTOLA seats under 345263 to ciotola", () => {
    const { rows } = seedRowsFromBackup([
      { id: 2, from_email: "A@x.com", client_id: 345263, tags: [{ tag_name: "JEREMY-CIOTOLA" }] },
      { id: 1, from_email: "b@x.com", client_id: 345263 },
    ]);
    assert.deepEqual(rows, [
      { id: 1, from_email: "b@x.com", slug: "salesglider" },
      { id: 2, from_email: "a@x.com", slug: "ciotola" },
    ]);
  });

  it("append adds new rows, no-ops on an identical seeded row, and refuses to reassign or take an unknown slug", () => {
    const seeded = MAILBOX_OWNER_SEED[0]!;
    const out = mergeSeedRows(MAILBOX_OWNER_SEED, [
      { id: 990_000_001, from_email: "New@acme.com", slug: "bcp" },
      { id: seeded.id, from_email: seeded.from_email, slug: seeded.slug },
    ]);
    assert.equal(out.added, 1);
    assert.equal(out.unchanged, 1);
    assert.equal(out.rows.length, MAILBOX_OWNER_SEED.length + 1);
    assert.equal(out.rows.at(-1)!.from_email, "new@acme.com");
    assert.throws(() => mergeSeedRows(MAILBOX_OWNER_SEED, [{ id: seeded.id, from_email: "x@y.com", slug: "nexus_x" }]), /unknown slug/);
    const other = seeded.slug === "bcp" ? "emcor" : "bcp";
    assert.throws(() => mergeSeedRows(MAILBOX_OWNER_SEED, [{ id: seeded.id, from_email: "x@y.com", slug: other }]), /never reassigned/);
    assert.throws(() => mergeSeedRows([], [{ id: 5, slug: "bcp" }]), /from_email/);
  });
});
