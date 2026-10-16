import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatSecretScrubLog,
  looksUnredactedSecret,
  redactSecrets,
  requestLabel,
  safeErrorText,
  stripUpstreamUrls,
  tallySecretLeftovers,
} from "./redact.js";
import { MemoryStore } from "../store.js";

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

describe("leftover secret counts after scrub (never values)", () => {
  it("treats api_key=REDACTED as clean and api_key=LIVE as leftover", () => {
    assert.equal(looksUnredactedSecret("GET /x?api_key=REDACTED → 404"), false);
    assert.equal(looksUnredactedSecret("GET /x?api_key=LIVESECRET → 404"), true);
    assert.equal(looksUnredactedSecret('{"api_key":"REDACTED"}'), false);
    assert.equal(looksUnredactedSecret('{"api_key":"live-secret"}'), true);
    assert.equal(looksUnredactedSecret("Authorization: Bearer REDACTED"), false);
    assert.equal(looksUnredactedSecret("Authorization: Bearer abc.def"), true);
  });

  it("logs integers only even when rows still hold a raw key", async () => {
    const store = new MemoryStore();
    store.stamps.set("isolation", {
      stage: "isolation",
      lastError: "GET https://x.test/api?api_key=SUPERSECRET → 404",
      consecutiveFailures: 1,
    });
    store.findings.push({
      kind: "ugly_without_isolation",
      detail: "ok",
    });
    await store.logIntended({
      kind: "slack",
      payload: { url: "https://x.test/?token=LEAKEDTOKEN" },
      executed: false,
      shadowed: true,
      writeEnabled: false,
    });
    const counts = await store.countUnredactedSecretRows();
    assert.equal(counts.stageHealth, 1);
    assert.equal(counts.findings, 0);
    assert.equal(counts.jsonPayloads, 1);
    const line = formatSecretScrubLog(counts);
    assert.equal(
      line,
      "[v2] leftover secrets after scrub: stage_health=1 findings=0 json_payloads=1 total=2",
    );
    assert.doesNotMatch(line, /SUPERSECRET|LEAKEDTOKEN|api_key=/);
    const clean = formatSecretScrubLog(tallySecretLeftovers({}));
    assert.match(clean, /total=0/);
  });
});

