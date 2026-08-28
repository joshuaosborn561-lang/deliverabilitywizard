import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  espMixFromAccountTypes,
  platformsFromActionDetail,
  platformsMatchingEspMix,
} from "./retireEspMix.js";

describe("retireEspMix", () => {
  it("counts Smartlead account types into Google/Microsoft", () => {
    assert.deepEqual(
      espMixFromAccountTypes(["GMAIL", "OUTLOOK", "GMAIL", "SMTP"]),
      { GOOGLE: 2, MICROSOFT: 1 },
    );
  });

  it("mirrors a Microsoft-heavy retired domain onto the replacement order", () => {
    assert.deepEqual(
      platformsMatchingEspMix({ GOOGLE: 0, MICROSOFT: 5 }, 3),
      ["MICROSOFT", "MICROSOFT", "MICROSOFT"],
    );
    assert.deepEqual(
      platformsMatchingEspMix({ GOOGLE: 2, MICROSOFT: 1 }, 3),
      ["GOOGLE", "GOOGLE", "MICROSOFT"],
    );
  });

  it("reads platforms or espMix from the retire/buy action detail", () => {
    assert.deepEqual(
      platformsFromActionDetail(
        { platforms: ["MICROSOFT", "MICROSOFT", "GOOGLE"] },
        3,
      ),
      ["MICROSOFT", "MICROSOFT", "GOOGLE"],
    );
    assert.deepEqual(
      platformsFromActionDetail({ espMix: { GOOGLE: 0, MICROSOFT: 4 } }, 3),
      ["MICROSOFT", "MICROSOFT", "MICROSOFT"],
    );
    assert.equal(platformsFromActionDetail({}, 3), null);
  });
});
