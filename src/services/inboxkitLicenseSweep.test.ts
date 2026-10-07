import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { InboxkitLicenseSweepService } from "./inboxkitLicenseSweep.js";

const mondayMorning = new Date("2026-10-05T13:16:00.000Z");
const saturday = new Date("2026-10-03T13:16:00.000Z");

function stateFile(): string {
  return `/tmp/ik-license-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    ...loadConfig({} as NodeJS.ProcessEnv),
    dryRun: false,
    enableInboxkitLicenseSweep: true,
    ...overrides,
  };
}

async function readyState(): Promise<StateStore> {
  const state = new StateStore(stateFile());
  await state.load();
  return state;
}

describe("InboxkitLicenseSweepService (D222/D226)", () => {
  it("idles on a weekend and on Monday hands off findings then Slacks only after delete", async () => {
    const notes: string[] = [];
    const deletedSl: number[] = [];
    const cancelledIk: string[][] = [];
    const state = await readyState();
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
        deleteEmailAccount: async (id: number) => {
          deletedSl.push(id);
        },
      },
      {
        listWorkspaces: async () => [{ uid: "ws-1" }],
        listAllMailboxes: async () => [
          { email: "ada@x.com", status: "cancelled", uid: "ik-ada" },
        ],
        cancelMailboxes: async (uids: string[]) => {
          cancelledIk.push([...uids]);
        },
      },
      {
        notifyDeliverabilityNote: async (text) => {
          notes.push(text);
          return undefined;
        },
      },
      state,
    );

    const weekend = await service.run({ now: saturday });
    assert.equal(weekend.skipped, true);
    assert.match(String(weekend.reason), /weekend/);
    assert.equal(notes.length, 0);

    const monday = await service.run({ now: mondayMorning });
    assert.equal(monday.findings.length, 1);
    assert.equal(monday.deleted, 1);
    assert.equal(monday.posted, true);
    assert.deepEqual(deletedSl, [1]);
    assert.deepEqual(cancelledIk, [["ik-ada"]]);
    assert.deepEqual(notes, [
      "Found 1 inboxes that had lapsed; they're deleted from Smartlead and InboxKit.",
    ]);
    assert.doesNotMatch(notes[0]!, /—/);
    assert.doesNotMatch(notes[0]!, /still connected|scheduled for cancellation|TechEvo/);
    const handoff = state.getInboxkitLicenseHandoff();
    assert.equal(handoff?.clients[0]?.clientName, "TechEvo");
    assert.equal(handoff?.clients[0]?.stillConnected[0]?.email, "ada@x.com");
    assert.equal(handoff?.deleted, 1);
    assert.ok(
      state.listOpsAudit().some((row) => row.action === "inboxkit-license-handoff"),
    );
  });

  it("does not Slack upcoming cancellations and does not delete them", async () => {
    const notes: string[] = [];
    const deletedSl: number[] = [];
    const state = await readyState();
    const service = new InboxkitLicenseSweepService(
      config(),
      {
        listAllEmailAccounts: async () => [
          { id: 2, from_email: "soon@x.com", client_id: 77, is_smtp_success: true },
        ],
        listClients: async () => [{ id: 77, name: "TechEvo", logo: "TechEvo" }],
        deleteEmailAccount: async (id: number) => {
          deletedSl.push(id);
        },
      },
      {
        listWorkspaces: async () => [{ uid: "ws-1" }],
        listAllMailboxes: async () => [
          {
            email: "soon@x.com",
            status: "scheduled_for_cancellation",
            renewal_date: "2026-11-01",
            uid: "ik-soon",
          },
        ],
        cancelMailboxes: async () => {
          throw new Error("must not cancel upcoming");
        },
      },
      {
        notifyDeliverabilityNote: async (text) => {
          notes.push(text);
          return undefined;
        },
      },
      state,
    );
    const result = await service.run({ now: mondayMorning, force: true });
    assert.equal(result.findings[0]?.kind, "scheduled_cancel");
    assert.equal(result.deleted, 0);
    assert.equal(result.posted, false);
    assert.deepEqual(deletedSl, []);
    assert.deepEqual(notes, []);
    assert.equal(
      state.getInboxkitLicenseHandoff()?.clients[0]?.upcomingCancellations[0]?.cancelDate,
      "2026-11-01",
    );
  });
});

describe("D245 — weekday sweep deletes latoyaflatley (real IK row shape)", () => {
  it("Wednesday run deletes the past-cancel seat, records seat ends, and blocks staffing", async () => {
    const wednesday = new Date("2026-10-07T13:16:00.000Z");
    const deletedSl: number[] = [];
    const cancelledIk: string[][] = [];
    const pageSizes: Array<number | undefined> = [];
    const notes: string[] = [];
    const state = await readyState();
    const service = new InboxkitLicenseSweepService(
      config(),
      {
        listAllEmailAccounts: async () => [
          {
            id: 18696010,
            from_email: "latoyaflatley@culturefitsaio.info",
            client_id: 597783,
            is_smtp_success: true,
            is_imap_success: true,
          },
          {
            id: 21831356,
            from_email: "raymondpatel@outreachdeskhub.com",
            client_id: null,
            is_smtp_success: true,
            is_imap_success: true,
          },
        ],
        listClients: async () => [{ id: 597783, name: "Deep Roots Capital", logo: "Deep Roots" }],
        deleteEmailAccount: async (id: number) => {
          deletedSl.push(id);
        },
      },
      {
        listWorkspaces: async () => [{ uid: "ws-cf" }],
        listAllMailboxes: async (_ws?: string, pageSize?: number) => {
          pageSizes.push(pageSize);
          return [
            {
              uid: "80d9a72a-d072-476f-b179-7859905f9440",
              username: "latoyaflatley",
              domain_name: "culturefitsaio.info",
              status: "scheduled_for_cancellation",
              renewal_date: "2026-09-11T18:22:03.586Z",
            },
            {
              uid: "a378c98e",
              username: "raymondpatel",
              domain_name: "outreachdeskhub.com",
              status: "active",
              renewal_date: "2026-09-24T00:49:56.000Z",
            },
          ] as never;
        },
        cancelMailboxes: async (uids: string[]) => {
          cancelledIk.push([...uids]);
        },
      },
      {
        notifyDeliverabilityNote: async (text) => {
          notes.push(text);
          return undefined;
        },
      },
      state,
    );

    const result = await service.run({ now: wednesday });
    assert.equal(result.skipped, undefined);
    assert.equal(result.deleted, 1);
    assert.deepEqual(deletedSl, [18696010]);
    assert.deepEqual(cancelledIk, [["80d9a72a-d072-476f-b179-7859905f9440"]]);
    assert.deepEqual(pageSizes, [100]);
    assert.deepEqual(notes, [
      "Found 1 inboxes that had lapsed; they're deleted from Smartlead and InboxKit.",
    ]);
    assert.equal(state.isInboxKitLapsed("latoyaflatley@culturefitsaio.info", wednesday), true);
    assert.equal(state.isInboxKitEndingSoon("LatoyaFlatley@culturefitsaio.info", wednesday), true);
    assert.equal(state.isInboxKitEndingSoon("raymondpatel@outreachdeskhub.com", wednesday), false);
  });
});
