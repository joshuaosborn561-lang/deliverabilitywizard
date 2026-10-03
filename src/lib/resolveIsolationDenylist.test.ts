import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IncompleteEmailAccountListError } from "../clients/smartlead.js";
import { resolveIsolationDenylist } from "./resolveIsolationDenylist.js";

describe("resolveIsolationDenylist (D220)", () => {
  it("does not treat a failed fleet list as an empty denylist", async () => {
    await assert.rejects(
      () =>
        resolveIsolationDenylist(
          {
            isolationDomain: "isolation.test",
            isolationMailboxIds: [],
            isolationMailboxEmails: [],
          },
          {
            listAllEmailAccounts: async () => {
              throw new IncompleteEmailAccountListError(
                "Smartlead GET /email-accounts returned a non-list page.",
              );
            },
          },
        ),
      IncompleteEmailAccountListError,
    );
  });
});
