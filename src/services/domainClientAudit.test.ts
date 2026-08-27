import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import type { InventoryBook } from "./inventory.js";
import { DomainClientAuditService } from "./domainClientAudit.js";

function bookWith(
  campaigns: unknown[],
  accounts: unknown[],
  clients: unknown[] = [],
): InventoryBook {
  return {
    get: async () => ({ campaigns, accounts, clients, fetchedAt: Date.now() }),
  } as unknown as InventoryBook;
}

describe("DomainClientAuditService (D136)", () => {
  it("flags split and unmapped domains, skips fleets/BCP/retired, never writes a client", async () => {
    const state = new StateStore(
      `/tmp/dw-domain-audit-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertDomainHistory({
      domain: "deaddomain.info",
      status: "retired",
    } as never);

    const campaigns = [
      { id: 1, name: "Acme A", status: "ACTIVE", client_id: 100 },
      { id: 2, name: "Bcorp B", status: "ACTIVE", client_id: 200 },
    ];
    const clients = [
      { id: 100, name: "Acme" },
      { id: 200, name: "Bcorp" },
    ];
    const accounts = [
      // split: same domain, two clients
      { id: 1, from_email: "x@splitdomain.info", client_id: 100, campaign_ids: [1] },
      { id: 2, from_email: "y@splitdomain.info", client_id: 200, campaign_ids: [2] },
      // unmapped: no client anywhere
      { id: 3, from_email: "who@lonely.info", client_id: null, campaign_ids: [] },
      // clean single-client domain
      { id: 4, from_email: "ok@acmedomain.info", client_id: 100, campaign_ids: [1] },
      // pre-warmed generic fleet — skipped
      { id: 5, from_email: "gen@cleartechco.com", client_id: null, campaign_ids: [] },
      // BCP-owned replacement — skipped (D99)
      {
        id: 6,
        from_email: "b@keyboldercyperpartner.info",
        client_id: null,
        campaign_ids: [],
      },
      // retired — skipped
      { id: 7, from_email: "z@deaddomain.info", client_id: null, campaign_ids: [] },
    ];

    const service = new DomainClientAuditService(
      loadConfig({} as NodeJS.ProcessEnv),
      state,
      bookWith(campaigns, accounts, clients),
    );
    const { advisories } = await service.run();

    const byDomain = new Map(advisories.map((row) => [row.domain, row]));
    assert.equal(byDomain.get("splitdomain.info")?.kind, "split_clients");
    assert.match(byDomain.get("splitdomain.info")?.note ?? "", /Acme.*Bcorp|Bcorp.*Acme/);
    assert.equal(byDomain.get("lonely.info")?.kind, "unmapped");
    assert.equal(byDomain.size, 2, `only the two problems: ${[...byDomain.keys()].join(", ")}`);
    assert.equal(state.listDomainAdvisories().length, 2, "persisted for the EOD brief");
  });

  it("a later clean pass clears yesterday's advisories", async () => {
    const state = new StateStore(
      `/tmp/dw-domain-audit-clean-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.setDomainAdvisories([
      { domain: "old.info", kind: "unmapped", note: "stale", at: "2026-08-25T00:00:00Z" },
    ]);
    const service = new DomainClientAuditService(
      loadConfig({} as NodeJS.ProcessEnv),
      state,
      bookWith(
        [{ id: 1, name: "Acme A", status: "ACTIVE", client_id: 100 }],
        [{ id: 1, from_email: "ok@acmedomain.info", client_id: 100, campaign_ids: [1] }],
        [{ id: 100, name: "Acme" }],
      ),
    );
    const { advisories } = await service.run();
    assert.equal(advisories.length, 0);
    assert.equal(state.listDomainAdvisories().length, 0);
  });

  it("D142: ensures the markers and attaches only the confident cases", async () => {
    const state = new StateStore(
      `/tmp/dw-domain-attach-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const clients = [
      { id: 345263, name: "SalesGlider", logo: "SalesGlider" },
      { id: 418274, name: "Randy Haba", logo: "Parlay Tech" },
      { id: 100, name: "Acme" },
      { id: 200, name: "Bcorp" },
    ];
    const warmed = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const young = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const accounts = [
      // generic-fleet orphan → Generic marker (immediate — markers own no campaigns)
      { id: 1, from_email: "a@getintroducedapp.com", client_id: null, campaign_ids: [] },
      // generic-fleet box already owned by a real client → untouched
      { id: 2, from_email: "b@getintroducedapp.com", client_id: 100, campaign_ids: [] },
      // unmapped domain with exactly one client token, clock served → SalesGlider
      { id: 3, from_email: "u@salesgliderbox.info", client_id: null, campaign_ids: [], created_at: warmed },
      // unmapped domain with no client token → stays a human question
      { id: 4, from_email: "c@cornerstoneearthworksmy.info", client_id: null, campaign_ids: [] },
      // split-clients domain → advisory only, never written
      { id: 5, from_email: "x@splitdomain.info", client_id: 100, campaign_ids: [] },
      { id: 6, from_email: "y@splitdomain.info", client_id: 200, campaign_ids: [] },
      // D143 — confident match but the box still owes warmup days → deferred
      { id: 7, from_email: "n@salesgliderfresh.info", client_id: null, campaign_ids: [], created_at: young },
    ];

    const created: string[] = [];
    const writes: Array<{ id: number; client_id: unknown }> = [];
    const smartlead = {
      ensureClient: async (name: string) => {
        created.push(name);
        return name === "Generic" ? 900001 : 900002;
      },
      updateEmailAccount: async (
        id: number,
        fields: { client_id?: number | null },
      ) => {
        writes.push({ id, client_id: fields.client_id });
      },
    };

    const service = new DomainClientAuditService(
      loadConfig({ DRY_RUN: "false" }),
      state,
      bookWith([], accounts, clients),
      smartlead as never,
      async () => {},
    );
    const { advisories, attached } = await service.run();

    assert.deepEqual(created.sort(), ["Generic", "POC"]);
    assert.deepEqual(state.getMarkerClientIds(), {
      genericId: 900001,
      pocId: 900002,
    });
    assert.deepEqual(
      writes.sort((a, b) => a.id - b.id),
      [
        { id: 1, client_id: 900001 },
        { id: 3, client_id: 345263 },
      ],
      "only the orphan generic and the warmed confident salesglider box are written",
    );
    assert.ok(
      attached.some((row) => row.clientName === "Generic" && row.mailboxes === 1),
    );
    assert.ok(attached.some((row) => row.clientName === "SalesGlider"));
    const byDomain = new Map(advisories.map((row) => [row.domain, row.kind]));
    assert.equal(byDomain.get("cornerstoneearthworksmy.info"), "unmapped");
    assert.equal(byDomain.get("splitdomain.info"), "split_clients");
    // D143 — the young box's confident match waits out its 21 days.
    assert.equal(byDomain.get("salesgliderfresh.info"), "unmapped");
    const deferredNote = advisories.find(
      (row) => row.domain === "salesgliderfresh.info",
    )?.note;
    assert.match(deferredNote ?? "", /owe the 21-day warmup/);
    assert.equal(byDomain.size, 3);
  });
});
