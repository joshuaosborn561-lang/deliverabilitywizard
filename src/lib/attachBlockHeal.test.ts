import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSenderAttachBlocked, mergeAttachBlock } from "./attachBlock.js";
import {
  KNOWN_ATTACH_BLOCK_SEEDS,
  healAttachBlocks,
  persistKnownSeedAttachBlocks,
} from "./attachBlockHeal.js";

function memoryStore(seed?: {
  actions?: Array<{
    kind: string;
    status: string;
    detail: Record<string, unknown>;
  }>;
  history?: Array<{ domain: string; status?: string }>;
}) {
  const blocks = new Map();
  return {
    upsertAttachBlock: (incoming: {
      domain: string;
      emails?: Iterable<string>;
      accountIds?: Iterable<number>;
      reason: "burned" | "sender_blocked" | "restricted" | "bounce_isolation";
      source?: string;
    }) => {
      const merged = mergeAttachBlock(blocks.get(incoming.domain), incoming);
      blocks.set(merged.domain, merged);
      return merged;
    },
    listAttachBlocks: () => [...blocks.values()],
    listIsolationActions: () => seed?.actions ?? [],
    listDomainHistory: () => seed?.history ?? [],
    get: (domain: string) => blocks.get(domain),
  };
}

describe("attachBlockHeal (D176)", () => {
  it("seeds boldercyperpartnertop.info with the three burned accounts", () => {
    const store = memoryStore();
    const wrote = persistKnownSeedAttachBlocks(store);
    assert.deepEqual(wrote, ["boldercyperpartnertop.info"]);
    const seed = KNOWN_ATTACH_BLOCK_SEEDS[0]!;
    const block = store.get("boldercyperpartnertop.info");
    assert.ok(block);
    assert.equal(block.reason, "burned");
    assert.deepEqual(block.emails, [...seed.emails].sort());
    assert.deepEqual(
      block.accountIds,
      [...seed.accountIds].sort((a, b) => a - b),
    );
    assert.equal(
      isSenderAttachBlocked(
        { email: "jeremy@boldercyperpartnertop.info", accountId: 21442842 },
        { blocks: store.listAttachBlocks() },
      ),
      true,
    );
  });

  it("heals live asks, retired history, and the known seed in one pass", () => {
    const store = memoryStore({
      actions: [
        {
          kind: "retire_domain",
          status: "pending",
          detail: { domain: "boldercyperpartnerhub.info" },
        },
        {
          kind: "buy_domains",
          status: "pending",
          detail: { domain: "cleartechco.com", coverOnly: true },
        },
      ],
      history: [
        { domain: "oldburned.info", status: "retired" },
        { domain: "stillok.info", status: "watch" },
      ],
    });
    const result = healAttachBlocks(store);
    assert.ok(result.wrote >= 4);
    assert.ok(result.domains.includes("boldercyperpartnertop.info"));
    assert.ok(result.domains.includes("boldercyperpartnerhub.info"));
    assert.ok(result.domains.includes("cleartechco.com"));
    assert.ok(result.domains.includes("oldburned.info"));
    assert.equal(store.get("stillok.info"), undefined);
    const again = healAttachBlocks(store);
    assert.equal(again.wrote, 0, "second boot is a no-op");
  });
});
