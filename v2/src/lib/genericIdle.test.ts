import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { genericIdleFindings, isGenericSeat } from "./genericIdle.js";
import type { SlimAccount } from "../types.js";

function account(partial: Partial<SlimAccount> & Pick<SlimAccount, "id" | "email">): SlimAccount {
  return {
    fromName: "Ada",
    clientId: 10,
    campaignIds: [100],
    tags: ["POD-A"],
    smtpOk: true,
    imapOk: true,
    messagePerDay: 30,
    warmupBlocked: false,
    createdAt: "2020-01-01T00:00:00.000Z",
    warmupStartedAt: "2020-01-01T00:00:00.000Z",
    signature: "Ada\nAcme",
    ...partial,
  };
}

describe("generic_idle", () => {
  it("flags a GENERIC once named on-week staffable already meets the floor", () => {
    const named = account({ id: 1, email: "n@acme.info", tags: ["POD-A"] });
    const idle = account({ id: 2, email: "g@pool.info", tags: ["GENERIC", "POD-A"] });
    assert.equal(isGenericSeat(idle), true);
    const findings = genericIdleFindings({
      campaign: { id: 100, name: "Acme", status: "ACTIVE", clientId: 10 },
      accounts: [named, idle],
      floor: 1,
      week: "A",
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, "generic_idle");
    assert.equal(findings[0]?.email, "g@pool.info");
  });

  it("does not flag a generic that is still covering the floor", () => {
    const findings = genericIdleFindings({
      campaign: { id: 100, name: "Acme", status: "ACTIVE", clientId: 10 },
      accounts: [account({ id: 2, email: "g@pool.info", tags: ["GENERIC", "POD-A"] })],
      floor: 40,
      week: "A",
    });
    assert.equal(findings.length, 0);
  });
});
