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
});
