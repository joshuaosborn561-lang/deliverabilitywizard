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

  it("D190: same first-strike on crossscaleco.com does not re-Slack on remind", async () => {
    const state = await store();
    const slack = new FakeSlack();
    const svc = new DomainLifecycleService(
      loadConfig({} as NodeJS.ProcessEnv),
      state,
      slack as never,
    );
    await svc.afterReadings([
      { email: "breanna.e@crossscaleco.com", placement: "SPAM", ranAt: "t1" },
      { email: "breanna_esco@crossscaleco.com", placement: "SPAM", ranAt: "t1" },
      { email: "bre.escobar@crossscaleco.com", placement: "SPAM", ranAt: "t1" },
      { email: "ebreanna@crossscaleco.com", placement: "SPAM", ranAt: "t1" },
      { email: "escobar_b@crossscaleco.com", placement: "SPAM", ranAt: "t1" },
    ]);
    assert.equal(slack.actions.length, 1);
    assert.equal(state.listIsolationActions()[0]?.kind, "buy_domains");
    assert.doesNotMatch(
      JSON.stringify(slack.actions[0]),
      /protected client|Cayden cannot/i,
    );
    const { remindPendingIsolationActions } = await import(
      "../lib/isolationActions.js"
    );
    const posted = await remindPendingIsolationActions({
      store: state,
      slack: slack as never,
    });
    assert.equal(posted, 0);
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

  it("D181: a Goliath domain opens a normal retire ask, not cover-buy-only", async () => {
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
    const retire = actions.find((row) => row.kind === "retire_domain");
    assert.ok(retire, "Goliath burned domain opens a normal Retire ask (D181)");
    assert.match(retire?.title ?? "", /Retire nowoutreachdesk\.com/);
    assert.doesNotMatch(retire?.title ?? "", /not retiring/i);
    assert.doesNotMatch(retire?.proof ?? "", /protected client/i);
    assert.match(String(retire?.detail.parentDomain ?? ""), /goliath/);
    assert.doesNotMatch(String(retire?.detail.parentDomain ?? ""), /crosslaunchco/);
    assert.equal(
      state.getDomainHistory("nowoutreachdesk.com")?.status,
      "retire_pending",
    );
  });

  it("D179: an executed retire does not open a second ask on later fails", async () => {
    const state = await store();
    const slack = new FakeSlack();
    const svc = new DomainLifecycleService(
      loadConfig({} as NodeJS.ProcessEnv),
      state,
      slack as never,
    );
    state.upsertIsolationAction({
      id: "retire-run-1",
      kind: "retire_domain",
      status: "executed",
      title: "Retire salesgliderrun.com",
      proof: "already done",
      detail: { domain: "salesgliderrun.com" },
      allowed: "owner",
      requestedAt: "2026-08-20T00:00:00.000Z",
      executedAt: "2026-08-20T00:10:00.000Z",
    });
    await svc.afterReadings([
      { email: "a@salesgliderrun.com", placement: "SPAM", ranAt: "t1" },
      { email: "b@salesgliderrun.com", placement: "SPAM", ranAt: "t1" },
    ]);
    await svc.afterReadings([
      { email: "a@salesgliderrun.com", placement: "SPAM", ranAt: "t2" },
      { email: "b@salesgliderrun.com", placement: "SPAM", ranAt: "t2" },
    ]);
    const retires = state
      .listIsolationActions()
      .filter((row) => row.kind === "retire_domain");
    assert.equal(retires.length, 1, "executed retire is the only retire record");
    assert.equal(slack.actions.length, 0, "no fresh Retire Slack");
  });
});
