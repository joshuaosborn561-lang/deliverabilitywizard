import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import {
  GENERIC_ASSIGN_REASON_POD_TOP_UP,
  GENERIC_POOL_POD_FLOOR,
} from "../lib/genericPool.js";
import {
  GenericPoolCanonService,
  genericPoolFindingAlertText,
} from "./genericPoolCanon.js";

function testConfig() {
  return {
    dryRun: false,
    extraGenericMailboxes: [],
    extraGenericDomains: ["getintroduced.info"],
    prewarmedDomains: [],
    powerGrydClientId: 592842,
  } as unknown as ConstructorParameters<typeof GenericPoolCanonService>[0];
}

describe("D221 generic-pool canon service", () => {
  it("stores the table, flips findings, and pages Slack once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "generic-pool-"));
    const state = new StateStore(join(dir, "state.json"));
    await state.load();
    const sends: Array<{ text: string; kind?: string }> = [];
    const slack = {
      send: async (text: string, _thread?: unknown, kind?: string) => {
        sends.push({ text, kind });
      },
    };
    const service = new GenericPoolCanonService(testConfig(), state, slack);

    const named = Array.from({ length: GENERIC_POOL_POD_FLOOR }, (_, i) => ({
      id: 100 + i,
      email: `named${i}@techevolution.com`,
      type: "OUTLOOK",
      client_id: 77,
      campaign_ids: [10],
      tags: [{ tag_name: "POD-A" }],
      is_smtp_success: true,
      is_imap_success: true,
      created_at: "2026-01-01T00:00:00.000Z",
    }));

    const first = await service.run({
      inventory: {
        accounts: [
          ...named,
          {
            id: 1,
            email: "ada@getintroduced.info",
            type: "GMAIL",
            client_id: 77,
            campaign_ids: [10],
            tags: [{ tag_name: "POD-A" }, { tag_name: "GENERIC" }],
            is_smtp_success: true,
            is_imap_success: true,
          },
        ],
        campaigns: [{ id: 10, client_id: 77, status: "ACTIVE" }],
        clients: [{ id: 77, name: "Parlay" }],
      } as never,
    });

    assert.equal(first.findings.length, 1);
    assert.match(first.findings[0]!, /^generic_idle:/);
    assert.equal(state.listGenericSeats().length, 1);
    assert.equal(state.getGenericSeat("ada@getintroduced.info")?.assignedClientId, 77);
    assert.equal(state.getGenericSeat("ada@getintroduced.info")?.reason, GENERIC_ASSIGN_REASON_POD_TOP_UP);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]!.kind, "ops_alert");
    assert.match(sends[0]!.text, /generic pool assignment is wrong/);
    assert.doesNotMatch(sends[0]!.text, /—/);

    const second = await service.run({
      inventory: {
        accounts: [
          ...named,
          {
            id: 1,
            email: "ada@getintroduced.info",
            type: "GMAIL",
            client_id: 77,
            campaign_ids: [10],
            tags: [{ tag_name: "POD-A" }, { tag_name: "GENERIC" }],
            is_smtp_success: true,
            is_imap_success: true,
          },
        ],
        campaigns: [{ id: 10, client_id: 77, status: "ACTIVE" }],
        clients: [{ id: 77, name: "Parlay" }],
      } as never,
    });
    assert.equal(second.alerted.length, 0);
    assert.equal(sends.length, 1);

    const cleared = await service.run({
      inventory: {
        accounts: [
          ...named,
          {
            id: 1,
            email: "ada@getintroduced.info",
            type: "GMAIL",
            client_id: null,
            campaign_ids: [],
            tags: [{ tag_name: "GENERIC" }],
            is_smtp_success: true,
            is_imap_success: true,
          },
        ],
        campaigns: [{ id: 10, client_id: 77, status: "ACTIVE" }],
        clients: [{ id: 77, name: "Parlay" }],
      } as never,
    });
    assert.deepEqual(cleared.findings, []);
    assert.equal(state.getGenericSeat("ada@getintroduced.info")?.assignedClientId, null);
    assert.equal(state.listGenericPoolFindings().length, 0);
    assert.ok(cleared.recovered.length >= 1);

    await rm(dir, { recursive: true, force: true });
  });

  it("pages a multi-client assignment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "generic-pool-multi-"));
    const state = new StateStore(join(dir, "state.json"));
    await state.load();
    const sends: string[] = [];
    const service = new GenericPoolCanonService(testConfig(), state, {
      send: async (text: string) => {
        sends.push(text);
      },
    });
    const result = await service.run({
      inventory: {
        accounts: [
          {
            id: 1,
            email: "ada@getintroduced.info",
            type: "GMAIL",
            client_id: 77,
            campaign_ids: [10, 20],
            tags: [{ tag_name: "GENERIC" }],
            is_smtp_success: true,
            is_imap_success: true,
          },
        ],
        campaigns: [
          { id: 10, client_id: 77, status: "ACTIVE" },
          { id: 20, client_id: 88, status: "ACTIVE" },
        ],
        clients: [
          { id: 77, name: "Parlay" },
          { id: 88, name: "BCP" },
        ],
      } as never,
    });
    assert.ok(result.findings.some((line) => line.startsWith("generic_multi_client:")));
    assert.equal(sends.length, 1);
    assert.match(genericPoolFindingAlertText(result.findings), /D221/);
    await rm(dir, { recursive: true, force: true });
  });
});
