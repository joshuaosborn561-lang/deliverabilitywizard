/**
 * D331 / D332 — the committed mailbox → owner seed.
 *
 * Regenerate (ONLY from a backup taken BEFORE the 2026-11-11 client-space
 * deletion — afterwards every client_id is null; the script refuses to
 * shrink the seed):
 *
 *   npx tsx scripts/gen-mailbox-owner-seed.ts /path/to/email_accounts.json
 *
 * Append new mailboxes (bulk backfill; normal onboarding uses
 * POST /ownership/mailboxes instead — see docs/ONBOARDING-MAILBOX-OWNERSHIP.md):
 *
 *   npx tsx scripts/gen-mailbox-owner-seed.ts --append /path/to/rows.json
 *   # rows.json = [{ "id": 123, "from_email": "a@b.com", "slug": "bcp" }, ...]
 *
 * Writes data/mailbox-owner-seed.json and the embedded module
 * src/data/mailboxOwnerSeed.ts (id, from_email, slug only — no secrets).
 * JEREMY-CIOTOLA seats under 345263 are seeded `ciotola` (same legacy id).
 * After an append, update the seed-size assertions in
 * src/lib/ownership.test.ts in the same PR.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAILBOX_OWNER_SEED } from "../src/data/mailboxOwnerSeed.js";
import {
  assertSeedDoesNotShrink,
  mergeSeedRows,
  renderSeedJson,
  renderSeedModule,
  seedRowsFromBackup,
  type BackupAccount,
  type SeedRow,
} from "../src/lib/mailboxSeedTools.js";

const args = process.argv.slice(2);
const append = args[0] === "--append";
const input = append ? args[1] : args[0];
if (!input) {
  console.error("usage: gen-mailbox-owner-seed.ts <email_accounts.json> | --append <rows.json>");
  process.exit(1);
}
const parsed = JSON.parse(readFileSync(input, "utf8")) as unknown;
if (!Array.isArray(parsed)) {
  console.error("input must be a JSON array");
  process.exit(1);
}

let rows: SeedRow[];
if (append) {
  const merged = mergeSeedRows(MAILBOX_OWNER_SEED, parsed);
  console.log(`append: added=${merged.added} unchanged=${merged.unchanged}`);
  rows = merged.rows;
} else {
  const built = seedRowsFromBackup(parsed as BackupAccount[]);
  if (Object.keys(built.unknownClientIds).length) {
    console.error("client ids with no catalog slug:", built.unknownClientIds);
    process.exit(2);
  }
  assertSeedDoesNotShrink(built.rows, MAILBOX_OWNER_SEED);
  rows = built.rows;
}
const root = resolve(import.meta.dirname, "..");
writeFileSync(resolve(root, "data/mailbox-owner-seed.json"), renderSeedJson(rows));
writeFileSync(resolve(root, "src/data/mailboxOwnerSeed.ts"), renderSeedModule(rows));
console.log(`seed rows: ${rows.length}`);
