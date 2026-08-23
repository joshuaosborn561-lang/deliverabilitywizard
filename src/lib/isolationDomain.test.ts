import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IsolationAttachBlockedError,
  assertNotIsolationAccountIds,
  isIsolationEmail,
  isolationEmailsOf,
  normalizeIsolationDomain,
} from "./isolationDomain.js";

describe("isolation domain denylist", () => {
  it("matches the dedicated domain and explicit emails", () => {
    const denylist = {
      emails: isolationEmailsOf(["lab@iso.test", ""]),
      domain: normalizeIsolationDomain("Lab.Iso.test"),
    };
    assert.equal(isIsolationEmail("one@lab.iso.test", denylist), true);
    assert.equal(isIsolationEmail("lab@iso.test", denylist), true);
    assert.equal(isIsolationEmail("sales@client.com", denylist), false);
  });

  it("blocks campaign attach by account id", () => {
    assert.throws(
      () =>
        assertNotIsolationAccountIds([11, 22, 33], {
          accountIds: new Set([22]),
        }),
      (error: unknown) =>
        error instanceof IsolationAttachBlockedError &&
        error.blockedIds.join() === "22",
    );
    assert.doesNotThrow(() =>
      assertNotIsolationAccountIds([11], { accountIds: new Set([22]) }),
    );
  });
});
