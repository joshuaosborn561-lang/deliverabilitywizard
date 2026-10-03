import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { InboxkitLicenseSweepService } from "./inboxkitLicenseSweep.js";

const mondayMorning = new Date("2026-10-05T13:16:00.000Z");
const saturday = new Date("2026-10-03T13:16:00.000Z");

function config(overrides: Record<string, unknown> = {}) {
  return {
    ...loadConfig({} as NodeJS.ProcessEnv),
    dryRun: false,
    enableInboxkitLicenseSweep: true,
    ...overrides,
  };
}

describe("InboxkitLicenseSweepService (D222)", () => {
  it("idles on a weekend and posts a detection-only note on Monday", async () => {
    const notes: string[] = [];
    const service = new InboxkitLicenseSweepService(
      config(),
      {
        listAllEmailAccounts: async () => [
          {
            id: 1,
            from_email: "ada@x.com",
            client_id: 77,
            is_smtp_success: true,
          },
        ],
        listClients: async () => [{ id: 77, name: "TechEvo", logo: "TechEvo" }],
      },
      {
        listWorkspaces: async () => [{ uid: "ws-1" }],
        listAllMailboxes: async () => [
          { email: "ada@x.com", status: "cancelled" },
        ],
      },
      {
        notifyDeliverabilityNote: async (text) => {
          notes.push(text);
          return undefined;
        },
      },
    );

    const weekend = await service.run({ now: saturday });
    assert.equal(weekend.skipped, true);
    assert.match(String(weekend.reason), /weekend/);
    assert.equal(notes.length, 0);

    const monday = await service.run({ now: mondayMorning });
    assert.equal(monday.posted, true);
    assert.equal(monday.findings.length, 1);
    assert.match(notes[0]!, /No deletes and no unlinks/);
    assert.doesNotMatch(notes[0]!, /—/);
  });

  it("does not delete or unlink when a finding exists", async () => {
    const writes: string[] = [];
    const service = new InboxkitLicenseSweepService(
      config(),
      {
        listAllEmailAccounts: async () => [
          { id: 1, from_email: "ada@x.com", is_smtp_success: true },
        ],
        listClients: async () => [],
      },
      {
        listWorkspaces: async () => [{ uid: "ws-1" }],
        listAllMailboxes: async () => [
          { email: "ada@x.com", status: "inactive" },
        ],
      },
      { notifyDeliverabilityNote: async () => undefined },
    );
    const result = await service.run({ now: mondayMorning, force: true });
    assert.equal(result.findings[0]?.kind, "still_connected");
    assert.deepEqual(writes, []);
  });
});
