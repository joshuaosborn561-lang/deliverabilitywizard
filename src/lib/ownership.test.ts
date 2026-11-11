import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SmartleadClient, clientDisplayName, resolveAccountClient } from "../clients/smartlead.js";
import { MAILBOX_OWNER_SEED } from "../data/mailboxOwnerSeed.js";
import { isGenericMailbox } from "./clientInbox.js";
import { buildPods, type PodAccountInput } from "./pods.js";
import { isCanaryShellCampaign } from "./canaryShell.js";
import { isPodControlShellCampaign } from "./podControlShell.js";
import { isWordHuntShellCampaign } from "./wordHuntShell.js";
import {
  OWNER_CATALOG,
  applyAccountOwnership,
  emptyOwnershipOverrides,
  isWizardShellCampaignName,
  legacyClientRecords,
  loadOwnershipOverrides,
  ownershipOverrides,
  parseOwnershipOverrides,
  recordAccountOwner,
  recordCampaignOwner,
  resetOwnershipForTests,
  resolveAccountOwner,
  resolveCampaignOwner,
  seedById,
  sgOwnerSlug,
} from "./ownership.js";

const tag = (name: string) => ({ tag_id: 1, tag_name: name, tag_color: "#000" });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const originalFetch = globalThis.fetch;

beforeEach(() => resetOwnershipForTests());
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetOwnershipForTests();
});

describe("D331 catalog", () => {
  it("covers the 22 live sg-owner slugs", () => {
    assert.deepEqual(
      OWNER_CATALOG.map((e) => e.slug).sort(),
      [
        "bcp", "bpltg", "ciotola", "cornerstone", "culture_fits", "deeproots", "emcor",
        "goliath", "insight", "msrs", "nexus", "nieto", "nutter", "parlay", "peterson",
        "positive", "powergryd", "salesglider", "techevo", "vasco", "vector", "virtual_pulsar",
      ],
    );
  });

  it("keeps every client display name identical to the 2026-11-11 client list", () => {
    const names = Object.fromEntries(
      legacyClientRecords().map((r) => [r.id, clientDisplayName({ ...r, logo: r.logo ?? undefined })]),
    );
    assert.deepEqual(names, {
      345263: "SalesGlider",
      418274: "Parlay Tech (Randy Haba)",
      418275: "Culture Fits (TJ Johnson)",
      521881: "TechEvolution (Corey Tapper)",
      542838: "Bolder Cyber Partners (Mike Trpkosh)",
      548610: "Roofs by Peterson (Kyle Peterson)",
      548611: "Goliath Cybersecurity (Dave Ackley)",
      566991: "Nutter Group (Roger Nutter)",
      574020: "Emcor (Myles McIntosh)",
      582890: "Insight",
      592842: "PowerGRYD",
      597119: "Vector Energy Group",
      602897: "BPLTG",
      607522: "Nexus Dynamics Group",
      607625: "Virtual Pulsar",
    });
  });

  it("shell predicate matches the real shell helpers", () => {
    for (const name of ["Canary shell: #4456009 EMCOR", "Pod control shell", "DW Word Hunt Shell", "Parlay SEG"]) {
      const real =
        isCanaryShellCampaign({ name }) ||
        isPodControlShellCampaign({ name }) ||
        isWordHuntShellCampaign({ name });
      assert.equal(isWizardShellCampaignName(name), real, name);
    }
  });
});

describe("D331 campaign owner with client_id null", () => {
  it("sg-owner tag → legacy client id", () => {
    const r = resolveCampaignOwner({ id: 1, name: "Vector | X", client_id: null, tags: [tag("sg-owner:vector")] });
    assert.deepEqual(r, { clientId: 597119, slug: "vector", reason: "sg_owner_tag", ownerClientId: 597119 });
  });

  it("Ciotola-tagged campaigns keep SalesGlider's 345263 (as inside the SG space)", () => {
    const r = resolveCampaignOwner({ id: 4289735, name: "Ciotola | A", client_id: null, tags: [tag("sg-owner:ciotola")] });
    assert.equal(r.clientId, 345263);
    assert.equal(r.slug, "ciotola");
  });

  it("D332: a tagged shell keeps client_id null (never a client campaign) but is attributed", () => {
    const r = resolveCampaignOwner({ id: 2, name: "Canary shell: #4290206 PowerGRYD", client_id: null, tags: [tag("sg-owner:powergryd")] });
    assert.equal(r.clientId, null);
    assert.equal(r.reason, "shell_sg_owner_tag");
    assert.equal(r.slug, "powergryd");
    assert.equal(r.ownerClientId, 592842);
  });

  it("owners that never had a space (vasco, nieto, …) stay unassigned", () => {
    const r = resolveCampaignOwner({ id: 3, name: "Vasco - Service", client_id: null, tags: [tag("sg-owner:vasco")] });
    assert.equal(r.clientId, null);
    assert.equal(r.slug, "vasco");
  });

  it("two different sg-owner tags are ambiguous", () => {
    assert.equal(sgOwnerSlug([tag("sg-owner:bcp"), tag("sg-owner:emcor")]), null);
    assert.equal(resolveCampaignOwner({ id: 4, name: "x", tags: [tag("sg-owner:bcp"), tag("sg-owner:emcor")] }).clientId, null);
  });

  it("the tag beats a wizard override; the override fills an untagged campaign", () => {
    recordCampaignOwner(5, 418274);
    recordCampaignOwner(6, 418274);
    assert.equal(resolveCampaignOwner({ id: 5, name: "x", tags: [tag("sg-owner:bcp")] }).clientId, 542838);
    assert.equal(resolveCampaignOwner({ id: 6, name: "x", tags: [] }).clientId, 418274);
  });
});

describe("D331 mailbox owner with client_id null", () => {
  it("the seed has 1,590 rows matching the 2026-11-11 client_id counts", () => {
    assert.equal(MAILBOX_OWNER_SEED.length, 1590);
    const byLegacy: Record<number, number> = {};
    for (const row of MAILBOX_OWNER_SEED) {
      const id = OWNER_CATALOG.find((e) => e.slug === row.slug)!.legacyClientId!;
      byLegacy[id] = (byLegacy[id] ?? 0) + 1;
    }
    assert.deepEqual(byLegacy, {
      574020: 254, 345263: 253, 418274: 128, 597119: 120, 607522: 100, 582890: 88,
      542838: 87, 548611: 83, 592842: 82, 548610: 81, 566991: 80, 602897: 80,
      418275: 80, 607625: 74,
    });
    for (const row of MAILBOX_OWNER_SEED) {
      assert.deepEqual(Object.keys(row).sort(), ["from_email", "id", "slug"]);
    }
  });

  it("a seeded mailbox keeps its owner after client_id goes null", () => {
    const row = MAILBOX_OWNER_SEED.find((r) => r.slug === "emcor")!;
    const r = resolveAccountOwner({ id: row.id, client_id: null, tags: [] });
    assert.deepEqual(r, { clientId: 574020, slug: "emcor", reason: "seed", ownerClientId: 574020 });
  });

  it("a new named mailbox inherits the unique sg-owner of its campaigns", () => {
    const owners = new Map<number, number | null>([[10, 542838], [11, 542838], [12, null]]);
    const r = resolveAccountOwner(
      { id: 999_000_001, client_id: null, tags: [tag("type:google")], campaign_ids: [10, 11, 12] },
      { campaignOwner: (id) => owners.get(id) },
    );
    assert.equal(r.clientId, 542838);
    assert.equal(r.reason, "campaign_tags");
  });

  it("two campaign owners → unassigned", () => {
    const owners = new Map<number, number | null>([[10, 542838], [11, 574020]]);
    const r = resolveAccountOwner(
      { id: 999_000_002, client_id: null, campaign_ids: [10, 11] },
      { campaignOwner: (id) => owners.get(id) },
    );
    assert.equal(r.clientId, null);
  });

  it("GENERIC / POC / CANARY boxes never inherit a campaign owner (stay pool)", () => {
    const owners = new Map<number, number | null>([[10, 542838]]);
    for (const t of ["GENERIC", "POC", "CANARY"]) {
      const r = resolveAccountOwner(
        { id: 999_000_003, client_id: null, tags: [tag(t)], campaign_ids: [10] },
        { campaignOwner: (id) => owners.get(id) },
      );
      assert.equal(r.clientId, null, t);
    }
  });

  it("a wizard write (generic returned to pool) overrides the seed", () => {
    const row = MAILBOX_OWNER_SEED.find((r) => r.slug === "parlay")!;
    recordAccountOwner(row.id, null);
    assert.equal(resolveAccountOwner({ id: row.id, client_id: null }).clientId, null);
    recordAccountOwner(row.id, 418274);
    assert.equal(resolveAccountOwner({ id: row.id, client_id: null }).clientId, 418274);
  });

  it("override book round-trips through state and fires the persist hook", () => {
    let persisted = 0;
    loadOwnershipOverrides({ accounts: { "5": { clientId: 1, at: "x" }, bad: {} }, campaigns: {} }, () => {
      persisted += 1;
    });
    assert.deepEqual(Object.keys(ownershipOverrides().accounts), ["5"]);
    recordCampaignOwner(7, null);
    assert.equal(persisted, 1);
    const reparsed = parseOwnershipOverrides(JSON.parse(JSON.stringify(ownershipOverrides())));
    assert.equal(reparsed.campaigns["7"]!.clientId, null);
    assert.deepEqual(parseOwnershipOverrides(undefined), emptyOwnershipOverrides());
  });
});

describe("D331 pool classification does not change when client_id goes null", () => {
  const seedRows = ["emcor", "parlay", "salesglider", "ciotola", "insight", "powergryd", "vector", "nexus"].map(
    (slug) => MAILBOX_OWNER_SEED.find((r) => r.slug === slug)!,
  );
  const legacy = (slug: string) => OWNER_CATALOG.find((e) => e.slug === slug)!.legacyClientId!;
  const clientsById = new Map(legacyClientRecords().map((r) => [r.id, { ...r, logo: r.logo ?? undefined }]));
  const config = { extraGenericMailboxes: [], extraGenericDomains: [], prewarmedDomains: [] };
  const state = { getPoolMailbox: () => undefined };

  const fleet = (clientIdOf: (row: (typeof seedRows)[number]) => number | null) => [
    ...seedRows.map((row) => ({
      id: row.id,
      from_email: row.from_email,
      client_id: clientIdOf(row),
      tags: [tag("POD-A"), tag("type:google")],
    })),
    { id: 999_100_001, from_email: "pool@getintroducedhq.info", client_id: null, tags: [tag("GENERIC")] },
    { id: 999_100_002, from_email: "canary@x.info", client_id: null, tags: [tag("CANARY")] },
  ];

  it("isGenericMailbox, resolveAccountClient and buildPods are identical before and after", () => {
    const before = fleet((row) => legacy(row.slug));
    const after = fleet(() => null).map((a) => applyAccountOwnership({ ...a }));
    const pods = (accounts: typeof before) => {
      const inputs: PodAccountInput[] = accounts.map((a) => {
        const r = resolveAccountClient(a, new Map(), clientsById);
        return {
          accountId: a.id,
          email: a.from_email,
          clientId: r.clientId,
          clientName: r.clientName,
          tags: a.tags,
          onActiveCampaign: true,
          resting: false,
        };
      });
      return buildPods({
        accounts: inputs,
        config,
        state,
        isolation: { emails: new Set(), domain: null } as never,
        now: new Date("2026-11-11T17:00:00Z"),
      });
    };
    for (let i = 0; i < before.length; i += 1) {
      assert.equal(after[i]!.client_id, before[i]!.client_id, before[i]!.from_email);
      assert.equal(
        isGenericMailbox(after[i]!, after[i]!.from_email, config, state),
        isGenericMailbox(before[i]!, before[i]!.from_email, config, state),
      );
      assert.deepEqual(
        resolveAccountClient(after[i]!, new Map(), clientsById),
        resolveAccountClient(before[i]!, new Map(), clientsById),
      );
    }
    assert.deepEqual(pods(after), pods(before));
    // No client-owned seat fell into the pool.
    assert.equal(after.filter((a) => a.client_id === null).length, 2);
  });
});

describe("D331 SmartleadClient boundary", () => {
  it("listCampaigns reads include_tags=true, stamps owners, filters a client locally", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json([
        { id: 1, name: "BCP | A", status: "ACTIVE", client_id: null, tags: [tag("sg-owner:bcp")] },
        { id: 2, name: "Emcor | B", status: "ACTIVE", client_id: null, tags: [tag("sg-owner:emcor")] },
        { id: 3, name: "Canary shell: #1 BCP", status: "PAUSED", client_id: null, tags: [tag("sg-owner:bcp")] },
      ]);
    }) as typeof fetch;
    const client = new SmartleadClient("k");
    const all = await client.listCampaigns();
    assert.deepEqual(all.map((c) => c.client_id), [542838, 574020, null]);
    // D332 — the shell is attributed to BCP but its client_id stays null.
    assert.equal(all[2]!.owner_slug, "bcp");
    assert.equal(all[2]!.owner_client_id, 542838);
    const bcp = await client.listCampaigns(542838);
    assert.deepEqual(bcp.map((c) => c.id), [1]);
    for (const url of urls) {
      const u = new URL(url);
      assert.equal(u.searchParams.get("include_tags"), "true");
      assert.equal(u.searchParams.get("client_id"), null);
    }
  });

  it("getCampaign asks for include_tags=true", async () => {
    let url = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      url = String(input);
      return json({ id: 9, name: "Vector | A", status: "ACTIVE", client_id: null, tags: [tag("sg-owner:vector")] });
    }) as typeof fetch;
    const c = await new SmartleadClient("k").getCampaign(9);
    assert.match(url, /campaigns\/9\?/);
    assert.equal(new URL(url).searchParams.get("include_tags"), "true");
    assert.equal(c.client_id, 597119);
  });

  it("listAllEmailAccounts gives a seeded mailbox its owner back", async () => {
    const row = MAILBOX_OWNER_SEED.find((r) => r.slug === "nexus")!;
    let page = 0;
    globalThis.fetch = (async () => {
      page += 1;
      return json(page === 1 ? [{ id: row.id, from_email: row.from_email, client_id: null, tags: [] }] : []);
    }) as typeof fetch;
    const accounts = await new SmartleadClient("k").listAllEmailAccounts();
    assert.equal(accounts[0]!.client_id, 607522);
  });

  it("listClients serves the catalog without calling Smartlead", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return json([]);
    }) as typeof fetch;
    const clients = await new SmartleadClient("k").listClients();
    assert.equal(called, false);
    assert.equal(clients.length, 15);
    assert.equal(seedById().size, 1590);
  });

  it("client writes never reach Smartlead and never fail", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return json({ ok: true });
    }) as typeof fetch;
    const client = new SmartleadClient("k");
    await client.setCampaignClientId(77, 582890);
    await client.updateEmailAccount(88, { client_id: null });
    assert.equal(bodies.length, 0, "client-only writes make no HTTP call");
    await client.updateEmailAccount(89, { client_id: 418274, from_name: "Ann Lee" });
    await client.updateCampaignSettings(78, { client_id: 418274, track_settings: [] });
    assert.deepEqual(bodies, [{ from_name: "Ann Lee" }, { track_settings: [] }]);
    const book = ownershipOverrides();
    assert.equal(book.campaigns["77"]!.clientId, 582890);
    assert.equal(book.campaigns["78"]!.clientId, 418274);
    assert.equal(book.accounts["88"]!.clientId, null);
    assert.equal(book.accounts["89"]!.clientId, 418274);
  });
});
