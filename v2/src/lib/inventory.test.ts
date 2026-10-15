import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../store.js";
import { dedupeById } from "./inventory.js";

describe("inventory campaign upsert / dedupe", () => {
  it("dedupes duplicate campaign ids (4160571) keeping the last row", () => {
    const rows = dedupeById([
      { id: 4160571, name: "first" },
      { id: 1, name: "other" },
      { id: 4160571, name: "last" },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.id === 4160571)?.name, "last");
  });

  it("MemoryStore.saveInventory collapses duplicate campaign ids", async () => {
    const store = new MemoryStore();
    await store.saveInventory({
      fetchedAt: new Date().toISOString(),
      campaigns: [
        { id: 4160571, name: "A", status: "ACTIVE", clientId: 1 },
        { id: 4160571, name: "B", status: "PAUSED", clientId: 1 },
      ],
      accounts: [
        {
          id: 9,
          email: "a@x.test",
          fromName: "A",
          clientId: 1,
          campaignIds: [4160571],
          tags: [],
          smtpOk: true,
          imapOk: true,
          messagePerDay: 30,
          warmupBlocked: false,
          createdAt: null,
          warmupStartedAt: null,
          signature: "",
        },
        {
          id: 9,
          email: "b@x.test",
          fromName: "B",
          clientId: 1,
          campaignIds: [4160571],
          tags: [],
          smtpOk: true,
          imapOk: true,
          messagePerDay: 30,
          warmupBlocked: false,
          createdAt: null,
          warmupStartedAt: null,
          signature: "",
        },
      ],
    });
    const book = await store.loadInventory();
    assert.equal(book?.campaigns.length, 1);
    assert.equal(book?.campaigns[0]?.name, "B");
    assert.equal(book?.accounts.length, 1);
    assert.equal(book?.accounts[0]?.email, "b@x.test");
  });
});
