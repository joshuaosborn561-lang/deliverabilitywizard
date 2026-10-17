import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyGenericSeat } from "./genericPool.js";
import {
  genericLedgerSupabaseNeeded,
  genericSeatToLedgerRow,
  readGenericLedgerSupabaseEnv,
  upsertGenericLedgerToSupabase,
} from "./genericLedgerSupabase.js";

describe("D286 supabase ledger mirror", () => {
  it("stays off without credentials and does not invent keys", () => {
    assert.equal(readGenericLedgerSupabaseEnv({}), null);
    assert.ok(genericLedgerSupabaseNeeded().some((row) => row.includes("SUPABASE_URL")));
  });

  it("upserts when URL + service role are present", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await upsertGenericLedgerToSupabase({
      seats: [
        emptyGenericSeat("ada@getintroduced.info", {
          slAccountId: 9,
          provider: "GOOGLE",
          warmupEnabled: true,
          assignedClientId: 77,
          assignedPod: "A",
          coveringFor: [
            { email: "n@techevolution.com", warmReadyAt: "2026-10-20T00:00:00.000Z" },
          ],
        }),
      ],
      env: {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role",
      },
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "[]")) });
        return new Response("", { status: 201 });
      }) as typeof fetch,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.upserted, 1);
    assert.match(calls[0]!.url, /generic_ledger/);
    const row = genericSeatToLedgerRow(
      emptyGenericSeat("ada@getintroduced.info", { warmupEnabled: false }),
    );
    assert.equal(row.warmup_enabled, false);
  });
});
