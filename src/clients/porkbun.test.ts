import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PorkbunAvailabilityGate,
  PorkbunClient,
  isPorkbunAvailabilityRateLimit,
} from "./porkbun.js";

describe("Porkbun availability lock", () => {
  it("serializes concurrent checks and sleeps before the request", async () => {
    const started: number[] = [];
    let now = 1_000;
    const sleeps: number[] = [];
    const gate = new PorkbunAvailabilityGate(
      50,
      async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      () => now,
      2,
    );
    const run = async (label: number) =>
      gate.enqueue(async () => {
        started.push(label);
        now += 5;
        return label;
      });
    const [a, b] = await Promise.all([run(1), run(2)]);
    assert.deepEqual([a, b].sort(), [1, 2]);
    assert.equal(started.length, 2);
    assert.ok(
      sleeps.some((ms) => ms >= 45),
      `second job must wait the gap before its request: ${sleeps.join(",")}`,
    );
  });

  it("retries a rate-limit error with backoff", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const gate = new PorkbunAvailabilityGate(
      10,
      async (ms) => {
        sleeps.push(ms);
      },
      () => Date.now(),
      3,
    );
    const result = await gate.enqueue(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("1 out of 1 checks within 10 seconds used.");
      }
      return { ok: true };
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(attempts, 3);
    assert.ok(sleeps.some((ms) => ms >= 10));
  });

  it("detects Porkbun's 10-second check wording", () => {
    assert.equal(
      isPorkbunAvailabilityRateLimit(
        new Error("1 out of 1 checks within 10 seconds used."),
      ),
      true,
    );
    assert.equal(
      isPorkbunAvailabilityRateLimit(new Error("domain taken")),
      false,
    );
  });

  it("PorkbunClient.checkDomainThrottled goes through the gate", async () => {
    const order: string[] = [];
    const gate = new PorkbunAvailabilityGate(
      1,
      async () => undefined,
      () => Date.now(),
      1,
    );
    const client = new PorkbunClient(
      { apiKey: "k", secretApiKey: "s" },
      gate,
    );
    const original = client.checkDomain.bind(client);
    (client as unknown as { checkDomain: typeof original }).checkDomain =
      async (domain: string) => {
        order.push(domain);
        return { available: true, price: "9.99", raw: {} };
      };
    await Promise.all([
      client.checkDomainThrottled("a.info"),
      client.checkDomainThrottled("b.info"),
    ]);
    assert.equal(order.length, 2);
  });
});
