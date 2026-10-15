import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SmartleadReader } from "./smartlead.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("staff email-account inventory paging", () => {
  it("delays between pages and does not put the api key in thrown errors", async () => {
    const offsets: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const u = new URL(String(url));
      offsets.push(u.searchParams.get("offset") ?? "");
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const row = { id: offset + 1, from_email: `a${offset}@x.test` };
      const rows = offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ ...row, id: i + 1 })) : [];
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const started = Date.now();
    const accounts = await new SmartleadReader("LIVESECRET", (fn) => fn(), 25).listAccounts();
    const elapsed = Date.now() - started;
    assert.equal(accounts.length, 100);
    assert.deepEqual(offsets, ["0", "100"]);
    assert.ok(elapsed >= 20, `expected page delay, elapsed=${elapsed}`);
  });
});
