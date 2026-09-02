import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { buildIsolationAction } from "../lib/isolationActions.js";
import { StateStore } from "../state/store.js";
import { IsolationBuyService } from "./isolationBuy.js";

function dryConfig() {
  return loadConfig({ DRY_RUN: "1" } as NodeJS.ProcessEnv);
}

function porkbunAllAvailable() {
  const checked: string[] = [];
  return {
    checked,
    client: {
      checkDomainThrottled: async (domain: string) => {
        checked.push(domain);
        return { available: true, price: "9.99", raw: {} };
      },
    },
  };
}

async function buyStore(): Promise<StateStore> {
  const state = new StateStore(
    `/tmp/dw-iso-buy-${process.pid}-${Date.now()}-${Math.random()}.json`,
  );
  await state.load();
  return state;
}

describe("IsolationBuyService — D161 client-named replace", () => {
  it("retiring a BCP domain buys boldercyperpartner* — never a crosslaunchco spin", async () => {
    const state = await buyStore();
    const porkbun = porkbunAllAvailable();
    const svc = new IsolationBuyService(
      dryConfig(),
      {} as never,
      porkbun.client as never,
      state,
      {} as never,
    );
    const action = buildIsolationAction({
      kind: "buy_domains",
      title: "Replacement for retired boldercyperpartnerpro.info",
      proof: "proof",
      detail: {
        domain: "boldercyperpartnerpro.info",
        retiredDomain: "boldercyperpartnerpro.info",
        // The stock path used to hard-code this generic parent (the incident).
        parentDomain: "crosslaunchco.com",
        quantity: 1,
      },
    });
    const result = await svc.run(action);
    assert.equal(result.domains.length, 1);
    const bought = result.domains[0]!;
    assert.match(bought, /boldercyperpartner/);
    assert.doesNotMatch(bought, /crosslaunchco/);
    assert.ok(
      porkbun.checked.every((d) => d.includes("boldercyperpartner")),
      `Porkbun was asked about generic spins: ${porkbun.checked.join(", ")}`,
    );
    assert.ok(
      !porkbun.checked.some((d) => d.includes("crosslaunchco")),
      "stock path must not even check a generic spin for a client retire",
    );
  });

  it("a generic-pool retire may still buy a crosslaunchco spin", async () => {
    const state = await buyStore();
    const porkbun = porkbunAllAvailable();
    const svc = new IsolationBuyService(
      dryConfig(),
      {} as never,
      porkbun.client as never,
      state,
      {} as never,
    );
    const action = buildIsolationAction({
      kind: "buy_domains",
      title: "Replacement for retired crosslaunchco.com",
      proof: "proof",
      detail: {
        domain: "crosslaunchco.com",
        retiredDomain: "crosslaunchco.com",
        parentDomain: "crosslaunchco.com",
        quantity: 1,
      },
    });
    const result = await svc.run(action);
    assert.equal(result.domains.length, 1);
    assert.match(result.domains[0]!, /crosslaunchco/);
  });
});
