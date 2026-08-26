import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  publicBaseUrlFromEnv,
  slackActionHref,
  slackInstallHref,
  verifySlackActionLink,
} from "./slackActionLink.js";

describe("slack action links", () => {
  it("round-trips a signed approve link and rejects a forged one", () => {
    const href = slackActionHref({
      baseUrl: "https://deliverabilitywizard-production.up.railway.app",
      secret: "secret",
      id: "buy_canary_fleet-1-abc",
      decision: "approve",
      nowMs: 1_000,
    });
    const url = new URL(href);
    assert.equal(url.pathname, "/slack/action");
    const ok = verifySlackActionLink({
      secret: "secret",
      id: url.searchParams.get("id") ?? "",
      decision: url.searchParams.get("decision") ?? "",
      exp: url.searchParams.get("exp") ?? "",
      sig: url.searchParams.get("sig") ?? "",
      nowMs: 2_000,
    });
    assert.deepEqual(ok, { ok: true, decision: "approve" });
    const forged = verifySlackActionLink({
      secret: "secret",
      id: url.searchParams.get("id") ?? "",
      decision: "approve",
      exp: url.searchParams.get("exp") ?? "",
      sig: "00",
      nowMs: 2_000,
    });
    assert.equal(forged.ok, false);
  });

  it("rejects an expired link", () => {
    const href = slackActionHref({
      baseUrl: "https://example.test",
      secret: "secret",
      id: "abc",
      decision: "deny",
      nowMs: 1_000,
      ttlMs: 10,
    });
    const url = new URL(href);
    const expired = verifySlackActionLink({
      secret: "secret",
      id: url.searchParams.get("id") ?? "",
      decision: url.searchParams.get("decision") ?? "",
      exp: url.searchParams.get("exp") ?? "",
      sig: url.searchParams.get("sig") ?? "",
      nowMs: 2_000,
    });
    assert.equal(expired.ok, false);
  });

  it("builds the public URL and Slack install URL", () => {
    assert.equal(
      publicBaseUrlFromEnv({ RAILWAY_PUBLIC_DOMAIN: "app.example" }),
      "https://app.example",
    );
    const install = slackInstallHref({
      clientId: "C123",
      redirectUri: "https://app.example/slack/oauth",
    });
    assert.match(install, /client_id=C123/);
    assert.match(install, /chat%3Awrite/);
  });
});
