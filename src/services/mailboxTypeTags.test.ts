import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { MailboxTypeTagService } from "./mailboxTypeTags.js";
import type { InventorySnapshot } from "./inventory.js";

describe("MailboxTypeTagService (D219)", () => {
  it("tags tidalstackco.com type:azure and a Gmail seat type:google", async () => {
    const assigned: Array<{ ids: number[]; tagIds: number[] }> = [];
    const ensured: string[] = [];
    const smartlead = {
      ensureTag: async (name: string) => {
        ensured.push(name);
        return { id: name === "type:azure" ? 1 : 2, name };
      },
      assignTags: async (ids: number[], tagIds: number[]) => {
        assigned.push({ ids, tagIds });
      },
      removeTags: async () => undefined,
    } as unknown as SmartleadClient;
    const inventory = {
      accounts: [
        {
          id: 11,
          type: "OUTLOOK",
          from_email: "ada@tidalstackco.com",
          tags: [],
        },
        {
          id: 12,
          type: "GMAIL",
          from_email: "bob@salesglider.com",
          tags: [],
        },
        {
          id: 13,
          type: "OUTLOOK",
          from_email: "cara@salesglider.com",
          tags: [{ tag_name: "type:m365" }],
        },
      ],
      campaigns: [],
      clients: [],
    } as unknown as InventorySnapshot;

    const service = new MailboxTypeTagService(
      loadConfig({
        CANON_OPS_WEEKDAY_ONLY: "false",
        CANON_OPS_HOUR_START: "0",
        CANON_OPS_HOUR_END: "24",
      }),
      smartlead,
      undefined,
      async () => undefined,
    );
    const result = await service.run({ inventory });
    assert.equal(result.assigned, 2);
    assert.ok(ensured.includes("type:azure"));
    assert.ok(ensured.includes("type:google"));
    assert.ok(assigned.some((row) => row.ids.includes(11) && row.tagIds.includes(1)));
    assert.ok(assigned.some((row) => row.ids.includes(12)));
  });

  it("idles on Saturday Chicago even at 10:00", async () => {
    const service = new MailboxTypeTagService(
      loadConfig({
        CANON_OPS_WEEKDAY_ONLY: "true",
        CANON_OPS_TIMEZONE: "America/Chicago",
        CANON_OPS_HOUR_START: "8",
        CANON_OPS_HOUR_END: "18",
      }),
      {
        ensureTag: async () => {
          throw new Error("should not tag on weekend idle");
        },
        assignTags: async () => undefined,
        removeTags: async () => undefined,
      } as unknown as SmartleadClient,
    );
    const result = await service.run({
      now: new Date("2026-10-03T15:00:00.000Z"),
      inventory: {
        accounts: [
          {
            id: 11,
            type: "OUTLOOK",
            from_email: "ada@tidalstackco.com",
            tags: [],
          },
        ],
        campaigns: [],
        clients: [],
      } as unknown as InventorySnapshot,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.assigned, 0);
  });
});
