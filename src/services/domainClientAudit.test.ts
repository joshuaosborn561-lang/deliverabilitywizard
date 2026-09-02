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

  it("D160: tags generics, detaches leftover marker clients, attaches only confident real clients", async () => {
    const state = new StateStore(
      `/tmp/dw-domain-attach-${process.pid}-${Date.now()}.json`,
    );
    await state.load();

    const clients = [
      { id: 345263, name: "SalesGlider", logo: "SalesGlider" },
      { id: 418274, name: "Randy Haba", logo: "Parlay Tech" },
      { id: 100, name: "Acme" },
      { id: 200, name: "Bcorp" },
      { id: 900001, name: "Generic", logo: "Generic" },
      { id: 900002, name: "POC", logo: "POC" },
    ];
    const warmed = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const young = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const accounts = [
      // generic-fleet orphan → GENERIC tag, no client_id
      { id: 1, from_email: "a@getintroducedapp.com", client_id: null, campaign_ids: [], tags: [] },
      // leftover D142 Generic client_id → tag + detach
      { id: 8, from_email: "z@getintroducedapp.com", client_id: 900001, campaign_ids: [], tags: [] },
      // generic-fleet box already owned by a real client → tagged, client_id untouched
      { id: 2, from_email: "b@getintroducedapp.com", client_id: 100, campaign_ids: [], tags: [] },
      // unmapped domain with exactly one client token, clock served → SalesGlider
      { id: 3, from_email: "u@salesgliderbox.info", client_id: null, campaign_ids: [], created_at: warmed, tags: [] },
      // unmapped domain with no client token → stays a human question
      { id: 4, from_email: "c@cornerstoneearthworksmy.info", client_id: null, campaign_ids: [], tags: [] },
      // split-clients domain → advisory only, never written
      { id: 5, from_email: "x@splitdomain.info", client_id: 100, campaign_ids: [], tags: [] },
      { id: 6, from_email: "y@splitdomain.info", client_id: 200, campaign_ids: [], tags: [] },
      // D143 — confident match but the box still owes warmup days → deferred
      { id: 7, from_email: "n@salesgliderfresh.info", client_id: null, campaign_ids: [], created_at: young, tags: [] },
    ];

    const writes: Array<{ id: number; client_id: unknown }> = [];
    const assigned: number[][] = [];
    const ensured: string[] = [];
    const smartlead = {
      ensureTag: async (name: string) => {
        ensured.push(name);
        return { id: 71, name };
      },
      assignTags: async (accountIds: number[]) => {
        assigned.push([...accountIds]);
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
    const { advisories, attached, tagged, detached, leftoverMarkerClients } =
      await service.run();

    assert.deepEqual(ensured, ["GENERIC"]);
    assert.ok(!ensured.includes("Generic") && !ensured.includes("POC"));
    assert.deepEqual(state.getMarkerClientIds(), {
      genericId: 900001,
      pocId: 900002,
    });
    assert.deepEqual(leftoverMarkerClients.sort(), ["Generic", "POC"]);
    assert.ok(tagged >= 1, "generic-fleet boxes get the GENERIC tag");
    assert.equal(detached, 1, "leftover Generic client_id is cleared");
    assert.ok(assigned.flat().includes(1));
    assert.ok(assigned.flat().includes(8));
    assert.deepEqual(
      writes.sort((a, b) => a.id - b.id),
      [
        { id: 3, client_id: 345263 },
        { id: 8, client_id: null },
      ],
      "only the leftover marker detach and the warmed confident salesglider box write a client_id",
    );
    assert.ok(!attached.some((row) => row.clientName === "Generic"));
    assert.ok(attached.some((row) => row.clientName === "SalesGlider"));
    const byDomain = new Map(advisories.map((row) => [row.domain, row.kind]));
    assert.equal(byDomain.get("cornerstoneearthworksmy.info"), "unmapped");
    assert.equal(byDomain.get("splitdomain.info"), "split_clients");
    assert.equal(byDomain.get("salesgliderfresh.info"), "unmapped");
    const deferredNote = advisories.find(
      (row) => row.domain === "salesgliderfresh.info",
    )?.note;
    assert.match(deferredNote ?? "", /owe the 21-day warmup/);
    assert.equal(byDomain.size, 3);
  });
});
