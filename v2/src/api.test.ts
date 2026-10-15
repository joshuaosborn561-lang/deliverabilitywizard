import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { createApi } from "./api.js";
import { loadConfig } from "./config.js";
import { MemoryStore } from "./store.js";

describe("/health never echoes secrets or upstream URLs", () => {
  const store = new MemoryStore();
  const app = createApi({ config: loadConfig({} as NodeJS.ProcessEnv), store });
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;

  after(() => {
    server.close();
  });

  it("redacts api_key and strips the SmartDelivery host from stageHealth.lastError", async () => {
    await store.stampError(
      "isolation",
      "GET https://smartdelivery.smartlead.ai/api/spam-tests?api_key=SUPERSECRET → 404",
    );
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      stageHealth?: Record<string, { lastError?: string }>;
    };
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /SUPERSECRET/);
    assert.doesNotMatch(text, /api_key=/);
    assert.doesNotMatch(text, /smartdelivery\.smartlead\.ai/);
    assert.doesNotMatch(text, /https?:\/\//);
    assert.match(String(body.stageHealth?.isolation?.lastError ?? ""), /\/api\/spam-tests/);
  });

  it("stampOk clears last_error and overdue", async () => {
    await store.stampError("staff", "GET /email-accounts → 429");
    let res = await fetch(`http://127.0.0.1:${port}/health`);
    let body = (await res.json()) as {
      overdueStages?: string[];
      stageHealth?: Record<string, { lastError?: string; overdue?: boolean }>;
    };
    assert.ok(body.overdueStages?.includes("staff"));
    assert.equal(body.stageHealth?.staff?.overdue, true);
    assert.match(String(body.stageHealth?.staff?.lastError ?? ""), /429/);

    await store.stampOk("staff");
    res = await fetch(`http://127.0.0.1:${port}/health`);
    body = (await res.json()) as {
      overdueStages?: string[];
      stageHealth?: Record<string, { lastError?: string; overdue?: boolean; lastOkAt?: string }>;
    };
    assert.equal(body.stageHealth?.staff?.lastError, undefined);
    assert.equal(body.stageHealth?.staff?.overdue, false);
    assert.ok(!body.overdueStages?.includes("staff"));
    assert.ok(body.stageHealth?.staff?.lastOkAt);
  });
});
