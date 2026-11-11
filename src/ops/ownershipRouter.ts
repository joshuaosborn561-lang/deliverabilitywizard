/**
 * D332 — onboarding path for NEW mailboxes now that Smartlead client spaces
 * are gone (D331). Mailboxes carry no sg-owner tag; their owner is the
 * committed 2026-11-11 seed plus the persisted override book. This router
 * lets the Onboarding bot register a new mailbox's owner in that book and
 * read back how any mailbox resolves.
 *
 *   POST /ownership/mailboxes            { assignments: [{ accountId, email?, slug }] }
 *   GET  /ownership/mailboxes/:accountId
 *   GET  /ownership/mailboxes?email=...
 *
 * Auth is the same `x-run-token` as /run and /status (503 when RUN_TOKEN is
 * not configured, 401 on a missing / wrong token). Nothing here calls
 * Smartlead: client_id is never written (spaces no longer exist).
 */
import { timingSafeEqual } from "node:crypto";
import express from "express";
import {
  OWNER_CATALOG,
  assignMailboxOwner,
  isPoolOrCanaryMailbox,
  mailboxOwnerSource,
  ownerCatalogEntry,
  ownershipOverrides,
  resolveAccountOwner,
  seedIdByEmail,
  type MailboxAssignmentResult,
} from "../lib/ownership.js";
import { MAILBOX_OWNER_SEED } from "../data/mailboxOwnerSeed.js";

export const MAX_ASSIGNMENTS_PER_REQUEST = 500;

/** Inventory row as the shared account book holds it (already stamped). */
export interface OwnershipAccountRow {
  id: number;
  from_email?: string;
  tags?: ReadonlyArray<{ tag_name?: string } | string> | null;
  campaign_ids?: readonly number[] | null;
  campaigns?: ReadonlyArray<{ id?: number; campaign_id?: number }> | null;
}

export interface OwnershipRouterDeps {
  runToken: string | undefined;
  /** Last accepted account book (null before the first health pass). */
  accounts: () => readonly OwnershipAccountRow[] | null | undefined;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Same contract as index.ts checkRunToken. */
export function runTokenGuard(runToken: string | undefined) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!runToken) {
      res.status(503).json({ error: "Protected route disabled: RUN_TOKEN is not configured" });
      return;
    }
    if (!safeEqual(req.header("x-run-token") || "", runToken)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}

const seedEmailById = new Map(MAILBOX_OWNER_SEED.map((row) => [row.id, row.from_email.toLowerCase()]));

function parseAccountId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d{1,15}$/.test(value.trim())) {
    const n = Number(value.trim());
    return n > 0 ? n : null;
  }
  return null;
}

export function createOwnershipRouter(deps: OwnershipRouterDeps): express.Router {
  const router = express.Router();
  router.use(runTokenGuard(deps.runToken));

  const accountIndex = () => {
    const byId = new Map<number, OwnershipAccountRow>();
    const byEmail = new Map<string, OwnershipAccountRow>();
    for (const row of deps.accounts() ?? []) {
      if (!row || typeof row.id !== "number") continue;
      byId.set(row.id, row);
      if (row.from_email) byEmail.set(row.from_email.trim().toLowerCase(), row);
    }
    return { byId, byEmail };
  };

  const describe = (accountId: number, row: OwnershipAccountRow | undefined) => {
    // The book's rows are already stamped (client_id = resolved owner), and
    // every Smartlead client_id is null since the spaces were deleted, so
    // re-resolve from the raw inputs with client_id null.
    const owner = resolveAccountOwner({
      id: accountId,
      client_id: null,
      tags: row?.tags ?? null,
      campaign_ids: row?.campaign_ids ?? null,
      campaigns: row?.campaigns ?? null,
    });
    const override = ownershipOverrides().accounts[String(accountId)];
    const source = mailboxOwnerSource(owner.reason);
    return {
      accountId,
      email: row?.from_email?.toLowerCase() ?? seedEmailById.get(accountId) ?? null,
      slug: owner.slug,
      clientId: owner.clientId,
      source,
      ...(source === "override" && override
        ? { overrideSource: override.source ?? null, overrideAt: override.at }
        : {}),
      inSeed: seedEmailById.has(accountId),
      inInventory: Boolean(row),
      ...(source === "campaign_inference"
        ? {
            note: "live inference from the sg-owner tags of the campaigns this mailbox sends on; not persisted — POST /ownership/mailboxes to pin it",
          }
        : {}),
    };
  };

  router.get("/mailboxes/:accountId", (req, res) => {
    const accountId = parseAccountId(req.params.accountId);
    if (accountId === null) {
      res.status(400).json({ error: "accountId must be a positive integer" });
      return;
    }
    res.json(describe(accountId, accountIndex().byId.get(accountId)));
  });

  router.get("/mailboxes", (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    if (!email) {
      res.status(400).json({ error: "pass ?email=<from_email> or use /ownership/mailboxes/:accountId" });
      return;
    }
    const { byEmail } = accountIndex();
    const row = byEmail.get(email);
    const accountId = row?.id ?? seedIdByEmail(email);
    if (accountId === undefined) {
      res.status(404).json({ error: "mailbox not found in the account book or the seed", email });
      return;
    }
    res.json(describe(accountId, row));
  });

  router.post("/mailboxes", (req, res) => {
    const body = (req.body ?? {}) as { assignments?: unknown };
    if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
      res.status(400).json({ error: "body must be { assignments: [{ accountId, email?, slug }] } with at least one row" });
      return;
    }
    if (body.assignments.length > MAX_ASSIGNMENTS_PER_REQUEST) {
      res.status(400).json({ error: `at most ${MAX_ASSIGNMENTS_PER_REQUEST} assignments per request` });
      return;
    }
    // Validate the whole batch before writing anything.
    const { byId } = accountIndex();
    const errors: Array<{ index: number; error: string }> = [];
    const rows: Array<{ accountId: number; slug: string; email?: string }> = [];
    const seen = new Map<number, string>();
    body.assignments.forEach((raw, index) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      const accountId = parseAccountId(item.accountId);
      if (accountId === null) {
        errors.push({ index, error: "accountId must be a positive integer (Smartlead email account id)" });
        return;
      }
      const slug = typeof item.slug === "string" ? item.slug.trim().toLowerCase().replace(/^sg-owner:/, "") : "";
      if (!slug || !ownerCatalogEntry(slug)) {
        errors.push({ index, error: `unknown owner slug ${JSON.stringify(item.slug ?? null)}` });
        return;
      }
      let email: string | undefined;
      if (item.email !== undefined && item.email !== null) {
        if (typeof item.email !== "string" || !item.email.includes("@")) {
          errors.push({ index, error: "email must be an email address" });
          return;
        }
        email = item.email.trim().toLowerCase();
        const known = byId.get(accountId)?.from_email?.trim().toLowerCase() ?? seedEmailById.get(accountId);
        if (known && known !== email) {
          errors.push({ index, error: `accountId ${accountId} is ${known}, not ${email}` });
          return;
        }
      }
      const prior = seen.get(accountId);
      if (prior !== undefined && prior !== slug) {
        errors.push({ index, error: `accountId ${accountId} appears twice with different slugs` });
        return;
      }
      seen.set(accountId, slug);
      rows.push({ accountId, slug, ...(email ? { email } : {}) });
    });
    if (errors.length) {
      res.status(400).json({
        error: "invalid assignments; nothing was written",
        errors,
        validSlugs: OWNER_CATALOG.map((e) => e.slug),
      });
      return;
    }
    const results: Array<MailboxAssignmentResult & { email?: string }> = rows.map((row) => {
      const inventoryRow = byId.get(row.accountId);
      // GENERIC / POC / CANARY boxes are assigned by min40 / POC fill (with
      // POD + signature), never claimed by onboarding.
      const result: MailboxAssignmentResult = isPoolOrCanaryMailbox(inventoryRow?.tags)
        ? {
            accountId: row.accountId,
            slug: row.slug,
            status: "conflict",
            reason: "mailbox is tagged GENERIC / POC / CANARY; pool and canary seats are never onboarded to a client",
            current: { slug: null, clientId: null, source: "pool_or_canary_tag" },
          }
        : assignMailboxOwner(row);
      return { ...result, ...(row.email ? { email: row.email } : {}) };
    });
    const count = (status: string) => results.filter((r) => r.status === status).length;
    const summary = {
      created: count("created"),
      updated: count("updated"),
      unchanged: count("unchanged"),
      conflict: count("conflict"),
    };
    console.log(
      `[ownership] D332 onboarding_api: created=${summary.created} updated=${summary.updated} unchanged=${summary.unchanged} conflict=${summary.conflict}`,
    );
    res.json({
      changed: summary.created + summary.updated,
      ...summary,
      results,
    });
  });

  return router;
}
