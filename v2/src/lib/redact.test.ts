import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSecrets, requestLabel, safeErrorText, stripUpstreamUrls } from "./redact.js";

describe("redact secrets from errors / logs / health", () => {
  it("redacts api_key and other key/token query params", () => {
    const leaked =
      "GET https://smartdelivery.smartlead.ai/api/spam-tests?api_key=SUPERSECRET&limit=10 → 404";
    const redacted = redactSecrets(leaked);
    assert.doesNotMatch(redacted, /SUPERSECRET/);
    assert.match(redacted, /api_key=REDACTED/);
    assert.equal(
      redactSecrets("https://x.test/?token=abc&key=zzz&access_token=yyy"),
      "https://x.test/?token=REDACTED&key=REDACTED&access_token=REDACTED",
    );
  });

  it("redacts JSON-style keys and Bearer tokens", () => {
    assert.doesNotMatch(redactSecrets('{"api_key":"live-secret"}'), /live-secret/);
    assert.equal(redactSecrets("Authorization: Bearer abc.def"), "Authorization: Bearer REDACTED");
  });

  it("strips upstream URLs down to a pathname", () => {
    const text =
      "GET https://smartdelivery.smartlead.ai/api/spam-tests?api_key=SUPERSECRET → 404";
    const out = stripUpstreamUrls(redactSecrets(text));
    assert.doesNotMatch(out, /https?:\/\//);
    assert.doesNotMatch(out, /smartdelivery\.smartlead\.ai/);
    assert.doesNotMatch(out, /SUPERSECRET/);
    assert.match(out, /\/api\/spam-tests/);
  });

  it("safeErrorText never keeps a raw URL or api_key value", () => {
    const err = new Error(
      "GET https://smartdelivery.smartlead.ai/api/v1/spam-test/report?api_key=LIVEKEY → 404 not found",
    );
    const out = safeErrorText(err);
    assert.doesNotMatch(out, /LIVEKEY/);
    assert.doesNotMatch(out, /https?:\/\//);
    assert.doesNotMatch(out, /api_key=[^R]/);
    assert.equal(
      requestLabel("GET", "https://smartdelivery.smartlead.ai/api/v1/spam-test/report?api_key=LIVEKEY"),
      "GET /api/v1/spam-test/report",
    );
  });
});
