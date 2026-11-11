import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import express from "express";
import { MAILBOX_OWNER_SEED } from "../data/mailboxOwnerSeed.js";
import { StateStore } from "../state/store.js";
import {
  loadOwnershipOverrides,
  noteCampaignOwner,
  ownershipOverrides,
  resetOwnershipForTests,
  resolveAccountOwner,
  type OwnershipOverrideState,
} from "../lib/ownership.js";
import { createOwnershipRouter, type OwnershipAccountRow } from "./ownershipRouter.js";

const TOKEN = "test-run-token-placeholder";
const NEW_ID = 990_000_001;

async function fixture(opts: { runToken?: string; accounts?: OwnershipAccountRow[] } = {}) {
  const persisted: OwnershipOverrideState[] = [];
  loadOwnershipOverrides(undefined, (s) => persisted.push(JSON.parse(JSON.stringify(s))));
  const app = express();
  app.use(express.json());
  app.use(
    "/ownership",
    createOwnershipRouter({
      runToken: "runToken" in opts ? opts.runToken : TOKEN,
      accounts: () => opts.accounts ?? [],
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}/ownership`;
  const post = (body: unknown, token: string | null = TOKEN) =>
    fetch(`${base}/mailboxes`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-run-token": token } : {}) },
      body: JSON.stringify(body),
    });
  const get = (path: string, token: string | null = TOKEN) =>
    fetch(`${base}${path}`, { headers: token ? { "x-run-token": token } : {} });
  return {
    post,
    get,
    persisted,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeEach(() => resetOwnershipForTests());
afterEach(() => resetOwnershipForTests());

describe("D332 /ownership/mailboxes auth", () => {
  it("401 without or with a wrong x-run-token, on POST and GET", async () => {
    const f = await fixture();
    try {
      assert.equal((await f.post({ assignments: [{ accountId: NEW_ID, slug: "bcp" }] }, null)).status, 401);
      assert.equal((await f.post({ assignments: [{ accountId: NEW_ID, slug: "bcp" }] }, "wrong")).status, 401);
      assert.equal((await f.get(`/mailboxes/${NEW_ID}`, null)).status, 401);
      assert.equal((await f.get(`/mailboxes?email=x@y.com`, null)).status, 401);
      assert.deepEqual(ownershipOverrides().accounts, {}, "nothing written");
    } finally {
      await f.close();
    }
  });

  it("503 when RUN_TOKEN is not configured (route disabled, never public)", async () => {
    const f = await fixture({ runToken: undefined });
    try {
      assert.equal((await f.post({ assignments: [{ accountId: NEW_ID, slug: "bcp" }] }, "")).status, 503);
    } finally {
      await f.close();
    }
  });
});

describe("D332 POST /ownership/mailboxes", () => {
  it("400 on an unknown slug and writes nothing from the batch", async () => {
    const f = await fixture();
    try {
      const res = await f.post({
        assignments: [
          { accountId: NEW_ID, slug: "bcp" },
          { accountId: NEW_ID + 1, slug: "deep_roots" },
        ],
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { errors: Array<{ index: number }>; validSlugs: string[] };
      assert.deepEqual(body.errors.map((e) => e.index), [1]);
      assert.ok(body.validSlugs.includes("deeproots"));
      assert.deepEqual(ownershipOverrides().accounts, {});
      assert.equal(f.persisted.length, 0);
    } finally {
      await f.close();
    }
  });

  it("400 on bad shapes: missing list, bad id, email that contradicts the account book, duplicate id", async () => {
    const f = await fixture({ accounts: [{ id: NEW_ID, from_email: "real@acme.com" }] });
    try {
      assert.equal((await f.post({})).status, 400);
      assert.equal((await f.post({ assignments: [] })).status, 400);
      assert.equal((await f.post({ assignments: [{ accountId: -3, slug: "bcp" }] })).status, 400);
      assert.equal((await f.post({ assignments: [{ accountId: NEW_ID, email: "other@acme.com", slug: "bcp" }] })).status, 400);
      assert.equal(
        (await f.post({ assignments: [{ accountId: 5, slug: "bcp" }, { accountId: 5, slug: "emcor" }] })).status,
        400,
      );
      assert.deepEqual(ownershipOverrides().accounts, {});
    } finally {
      await f.close();
    }
  });

  it("records a new mailbox in the persisted override book with source onboarding_api, idempotently", async () => {
    const f = await fixture({ accounts: [{ id: NEW_ID, from_email: "new@acme.com" }] });
    try {
      const first = await f.post({ assignments: [{ accountId: NEW_ID, email: "NEW@acme.com", slug: "sg-owner:BCP" }] });
      assert.equal(first.status, 200);
      const a = (await first.json()) as { changed: number; created: number; results: Array<{ status: string; clientId: number }> };
      assert.equal(a.changed, 1);
      assert.equal(a.results[0]!.status, "created");
      assert.equal(a.results[0]!.clientId, 542838);
      const book = ownershipOverrides().accounts[String(NEW_ID)]!;
      assert.equal(book.clientId, 542838);
      assert.equal(book.source, "onboarding_api");
      assert.equal(book.slug, "bcp");
      assert.equal(f.persisted.length, 1, "persist hook fired once");
      assert.equal(f.persisted[0]!.accounts[String(NEW_ID)]!.source, "onboarding_api");

      const again = (await (await f.post({ assignments: [{ accountId: NEW_ID, slug: "bcp" }] })).json()) as {
        changed: number;
        unchanged: number;
      };
      assert.equal(again.changed, 0);
      assert.equal(again.unchanged, 1);
      assert.equal(f.persisted.length, 1, "an idempotent repeat writes nothing");

      // The fleet read now resolves the mailbox to BCP.
      assert.equal(resolveAccountOwner({ id: NEW_ID, client_id: null }).clientId, 542838);

      // An onboarding mistake can be corrected by onboarding.
      const fix = (await (await f.post({ assignments: [{ accountId: NEW_ID, slug: "emcor" }] })).json()) as {
        updated: number;
        results: Array<{ previous: { slug: string } }>;
      };
      assert.equal(fix.updated, 1);
      assert.equal(fix.results[0]!.previous.slug, "bcp");
      assert.equal(ownershipOverrides().accounts[String(NEW_ID)]!.clientId, 574020);
    } finally {
      await f.close();
    }
  });

  it("the override book (with slug + source) survives a StateStore save / load round trip", async () => {
    const path = `/tmp/ownership-router-${process.pid}-${Date.now()}.json`;
    const store = new StateStore(path);
    await store.load();
    loadOwnershipOverrides(store.get().ownershipOverrides, (s) => {
      store.get().ownershipOverrides = s;
    });
    const f = await fixture();
    // fixture re-registers its own hook; re-register the store hook after it.
    loadOwnershipOverrides(store.get().ownershipOverrides, (s) => {
      store.get().ownershipOverrides = s;
    });
    try {
      await f.post({ assignments: [{ accountId: NEW_ID, slug: "vasco" }] });
      await store.save();
      const reloaded = new StateStore(path);
      await reloaded.load();
      const row = reloaded.get().ownershipOverrides.accounts[String(NEW_ID)]!;
      assert.equal(row.source, "onboarding_api");
      assert.equal(row.slug, "vasco");
      assert.equal(row.clientId, null, "vasco never had a space; the mailbox stays unassigned like its campaigns");
    } finally {
      await f.close();
    }
  });

  it("seeded mailboxes are unchanged: same slug is a no-op, another slug is a conflict", async () => {
    const seeded = MAILBOX_OWNER_SEED.find((r) => r.slug === "nexus")!;
    const f = await fixture();
    try {
      const body = (await (
        await f.post({
          assignments: [
            { accountId: seeded.id, email: seeded.from_email, slug: "nexus" },
            { accountId: MAILBOX_OWNER_SEED[0]!.id, slug: "parlay" },
          ],
        })
      ).json()) as { changed: number; results: Array<{ status: string; via?: string; current?: { source: string } }> };
      assert.equal(body.changed, 0);
      assert.equal(body.results[0]!.status, "unchanged");
      assert.equal(body.results[0]!.via, "seed");
      assert.equal(body.results[1]!.status, "conflict");
      assert.equal(body.results[1]!.current!.source, "seed");
      assert.deepEqual(ownershipOverrides().accounts, {}, "the seed is never shadowed by onboarding");
    } finally {
      await f.close();
    }
  });

  it("never reassigns a mailbox the wizard moved, and never claims GENERIC / POC / CANARY boxes", async () => {
    const f = await fixture({
      accounts: [
        { id: NEW_ID + 5, from_email: "g@pool.info", tags: [{ tag_name: "GENERIC" }] },
        { id: NEW_ID + 6, from_email: "c@canary.info", tags: [{ tag_name: "canary" }] },
      ],
    });
    try {
      loadOwnershipOverrides(
        { accounts: { [String(NEW_ID + 4)]: { clientId: 418274, at: "2026-11-11T00:00:00Z", source: "mailbox_client_write" } } },
        () => {},
      );
      const body = (await (
        await f.post({
          assignments: [
            { accountId: NEW_ID + 4, slug: "bcp" },
            { accountId: NEW_ID + 5, slug: "bcp" },
            { accountId: NEW_ID + 6, slug: "bcp" },
          ],
        })
      ).json()) as { conflict: number; changed: number };
      assert.equal(body.conflict, 3);
      assert.equal(body.changed, 0);
      assert.equal(ownershipOverrides().accounts[String(NEW_ID + 4)]!.clientId, 418274);
      assert.equal(ownershipOverrides().accounts[String(NEW_ID + 5)], undefined);
    } finally {
      await f.close();
    }
  });
});

describe("D332 GET /ownership/mailboxes", () => {
  it("reports seed / override / campaign-inference / none with the source", async () => {
    const seeded = MAILBOX_OWNER_SEED.find((r) => r.slug === "emcor")!;
    noteCampaignOwner(500, 542838);
    noteCampaignOwner(501, 542838);
    noteCampaignOwner(502, 574020);
    const f = await fixture({
      accounts: [
        { id: NEW_ID + 10, from_email: "agree@acme.com", tags: [], campaign_ids: [500, 501] },
        { id: NEW_ID + 11, from_email: "disagree@acme.com", tags: [], campaign_ids: [500, 502] },
        { id: NEW_ID + 12, from_email: "gen@pool.info", tags: [{ tag_name: "GENERIC" }], campaign_ids: [500] },
      ],
    });
    try {
      const seed = (await (await f.get(`/mailboxes/${seeded.id}`)).json()) as { source: string; slug: string; clientId: number };
      assert.deepEqual([seed.source, seed.slug, seed.clientId], ["seed", "emcor", 574020]);

      const byEmail = (await (await f.get(`/mailboxes?email=${encodeURIComponent(seeded.from_email.toUpperCase())}`)).json()) as {
        accountId: number;
      };
      assert.equal(byEmail.accountId, seeded.id);

      const agree = (await (await f.get(`/mailboxes/${NEW_ID + 10}`)).json()) as { source: string; slug: string };
      assert.deepEqual([agree.source, agree.slug], ["campaign_inference", "bcp"]);
      assert.equal(ownershipOverrides().accounts[String(NEW_ID + 10)], undefined, "inference is never persisted");

      const disagree = (await (await f.get(`/mailboxes/${NEW_ID + 11}`)).json()) as { source: string; slug: string | null };
      assert.deepEqual([disagree.source, disagree.slug], ["none", null]);

      const generic = (await (await f.get(`/mailboxes/${NEW_ID + 12}`)).json()) as { source: string };
      assert.equal(generic.source, "none", "GENERIC boxes never inherit a campaign owner");

      await f.post({ assignments: [{ accountId: NEW_ID + 11, slug: "emcor" }] });
      const pinned = (await (await f.get(`/mailboxes/${NEW_ID + 11}`)).json()) as {
        source: string;
        overrideSource: string;
        slug: string;
      };
      assert.deepEqual([pinned.source, pinned.overrideSource, pinned.slug], ["override", "onboarding_api", "emcor"]);

      assert.equal((await f.get(`/mailboxes?email=nobody@nowhere.com`)).status, 404);
      assert.equal((await f.get(`/mailboxes/abc`)).status, 400);
    } finally {
      await f.close();
    }
  });
});
