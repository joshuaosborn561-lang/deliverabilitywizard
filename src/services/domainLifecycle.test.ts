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
});
