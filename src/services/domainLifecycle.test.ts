import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { DomainLifecycleService } from "./domainLifecycle.js";

class FakeSlack {
  actions: unknown[] = [];
  async notifyIsolationAction(payload: unknown) {
    this.actions.push(payload);
  }
}

async function store(): Promise<StateStore> {
  const s = new StateStore(
    `/tmp/dw-domain-life-${process.pid}-${Date.now()}-${Math.random()}.json`,
  );
  await s.load();
  return s;
}

describe("DomainLifecycleService", () => {
  it("opens buy-ahead after one fleet fail with multiple inboxes", async () => {
    const state = await store();
    const slack = new FakeSlack();
    const svc = new DomainLifecycleService(
      loadConfig({} as NodeJS.ProcessEnv),
      state,
      slack as never,
    );
    const ranAt = "2026-08-23T12:00:00.000Z";
    await svc.afterReadings([
      { email: "a@crosslaunchco.com", placement: "SPAM", ranAt },
      { email: "b@crosslaunchco.com", placement: "SPAM", ranAt },
      { email: "c@crosslaunchco.com", placement: "SPAM", ranAt },
    ]);
    const actions = state.listIsolationActions();
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.kind, "buy_domains");
    assert.equal(slack.actions.length, 1);
  });

  it("opens retire after two consecutive domain fails", async () => {
    const state = await store();
    const slack = new FakeSlack();
    const svc = new DomainLifecycleService(
      loadConfig({} as NodeJS.ProcessEnv),
      state,
      slack as never,
    );
    await svc.afterReadings([
      { email: "a@crosslaunchco.com", placement: "SPAM", ranAt: "t1" },
      { email: "b@crosslaunchco.com", placement: "SPAM", ranAt: "t1" },
      { email: "c@crosslaunchco.com", placement: "SPAM", ranAt: "t1" },
    ]);
    await svc.afterReadings([
      { email: "a@crosslaunchco.com", placement: "SPAM", ranAt: "t2" },
      { email: "b@crosslaunchco.com", placement: "SPAM", ranAt: "t2" },
      { email: "c@crosslaunchco.com", placement: "SPAM", ranAt: "t2" },
    ]);
    assert.ok(state.listIsolationActions().some((row) => row.kind === "retire_domain"));
  });

  it("does not count the same cycle twice", async () => {
    const state = await store();
    const slack = new FakeSlack();
    const svc = new DomainLifecycleService(
      loadConfig({} as NodeJS.ProcessEnv),
      state,
      slack as never,
    );
    const fail = [
      { email: "a@crosslaunchco.com" as const, placement: "SPAM" as const, ranAt: "same" },
      { email: "b@crosslaunchco.com" as const, placement: "SPAM" as const, ranAt: "same" },
      { email: "c@crosslaunchco.com" as const, placement: "SPAM" as const, ranAt: "same" },
    ];
    await svc.afterReadings(fail);
    await svc.afterReadings(fail);
    assert.equal(state.getDomainHistory("crosslaunchco.com")?.consecutiveFails, 1);
    assert.equal(state.listIsolationActions().length, 1);
  });

  it("counts sitting inboxes on the known-good test", async () => {
    const state = await store();
    const slack = new FakeSlack();
    const svc = new DomainLifecycleService(
      loadConfig({} as NodeJS.ProcessEnv),
      state,
      slack as never,
    );
    await svc.afterReadings([
      { email: "a@crosslaunchco.com", placement: "SPAM", resting: true, ranAt: "t1" },
      { email: "b@crosslaunchco.com", placement: "SPAM", ranAt: "t1" },
      { email: "c@crosslaunchco.com", placement: "SPAM", ranAt: "t1" },
    ]);
    const action = state.listIsolationActions()[0];
    assert.match(action?.proof ?? "", /sitting off campaigns/i);
    assert.equal(slack.actions.length, 1);
  });

  it("D161: a BCP retire ask carries a client-brand parent, not crosslaunchco", async () => {
    const state = await store();
    const slack = new FakeSlack();
    const svc = new DomainLifecycleService(
      loadConfig({} as NodeJS.ProcessEnv),
      state,
      slack as never,
    );
    await svc.afterReadings([
      { email: "a@boldercyperpartnerpro.info", placement: "SPAM", ranAt: "t1" },
      { email: "b@boldercyperpartnerpro.info", placement: "SPAM", ranAt: "t1" },
    ]);
    await svc.afterReadings([
      { email: "a@boldercyperpartnerpro.info", placement: "SPAM", ranAt: "t2" },
      { email: "b@boldercyperpartnerpro.info", placement: "SPAM", ranAt: "t2" },
    ]);
    const retire = state
      .listIsolationActions()
      .find((row) => row.kind === "retire_domain");
    assert.ok(retire, "two consecutive BCP fails open retire");
    const parent = String(retire?.detail.parentDomain ?? "");
    assert.match(parent, /boldercyperpartner/);
    assert.doesNotMatch(parent, /crosslaunchco/);
  });

  it("D174: a protected client's domain opens a cover buy, never a retire ask", async () => {
    const state = await store();
    const slack = new FakeSlack();
    const svc = new DomainLifecycleService(
      loadConfig({} as NodeJS.ProcessEnv),
      state,
      slack as never,
    );
    const owner = {
      domain: "nowoutreachdesk.com",
      kind: "client" as const,
      clientId: 548611,
      clientName: "Goliath Cybersecurity (Dave Ackley)",
      mailboxCount: 3,
      uniqueClientIds: [548611],
      planSaysGeneric: true,
      conflict: true,
      source: "mailboxes" as const,
      updatedAt: "t1",
    };
    state.upsertDomainOwner(owner);
    await svc.afterReadings(
      [
        { email: "a@nowoutreachdesk.com", placement: "SPAM", ranAt: "t1" },
        { email: "b@nowoutreachdesk.com", placement: "SPAM", ranAt: "t1" },
        { email: "c@nowoutreachdesk.com", placement: "SPAM", ranAt: "t1" },
      ],
      {
        accounts: [
          { from_email: "a@nowoutreachdesk.com", client_id: 548611 },
          { from_email: "b@nowoutreachdesk.com", client_id: 548611 },
          { from_email: "c@nowoutreachdesk.com", client_id: 548611 },
        ] as never,
        clients: [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        ],
      },
    );
    await svc.afterReadings(
      [
        { email: "a@nowoutreachdesk.com", placement: "SPAM", ranAt: "t2" },
        { email: "b@nowoutreachdesk.com", placement: "SPAM", ranAt: "t2" },
        { email: "c@nowoutreachdesk.com", placement: "SPAM", ranAt: "t2" },
      ],
      {
        accounts: [
          { from_email: "a@nowoutreachdesk.com", client_id: 548611 },
          { from_email: "b@nowoutreachdesk.com", client_id: 548611 },
          { from_email: "c@nowoutreachdesk.com", client_id: 548611 },
        ] as never,
        clients: [
          { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
        ],
      },
    );
    const actions = state.listIsolationActions();
    assert.equal(
      actions.some((row) => row.kind === "retire_domain"),
      false,
      "protected client must not get a retire ask",
    );
    const buy = actions.find((row) => row.kind === "buy_domains");
    assert.ok(buy, "degrades to the buy/cover path");
    assert.match(buy?.title ?? "", /not retiring/i);
    assert.match(buy?.proof ?? "", /protected client/i);
    assert.match(String(buy?.detail.parentDomain ?? ""), /goliath/);
    assert.doesNotMatch(String(buy?.detail.parentDomain ?? ""), /crosslaunchco/);
    assert.equal(state.getDomainHistory("nowoutreachdesk.com")?.status, "watch");
  });
});
