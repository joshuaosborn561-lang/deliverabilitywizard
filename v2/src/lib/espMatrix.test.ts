import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { espInboxMatrix, seedEsp, senderEsp, toEspInboxDay } from "./espMatrix.js";

describe("ESP-to-ESP inbox matrix", () => {
  it("classifies Gmail vs Microsoft from email and seed provider", () => {
    assert.equal(senderEsp("ada@gmail.com"), "G");
    assert.equal(senderEsp("ada@client.info"), "MS");
    assert.equal(seedEsp("Gmail"), "G");
    assert.equal(seedEsp("Outlook"), "MS");
  });

  it("stores G→G, G→MS, MS→G, MS→MS rates", () => {
    const m = espInboxMatrix([
      { email: "g@gmail.com", inbox: true, provider: "gmail" },
      { email: "g@gmail.com", inbox: false, provider: "outlook" },
      { email: "m@contoso.info", inbox: true, provider: "gmail" },
      { email: "m@contoso.info", inbox: true, provider: "outlook" },
    ]);
    assert.equal(m.G_G, 100);
    assert.equal(m.G_MS, 0);
    assert.equal(m.MS_G, 100);
    assert.equal(m.MS_MS, 100);
  });

  it("writes a per-campaign per-day row", () => {
    const row = toEspInboxDay({
      campaignId: 1,
      day: "2026-10-15",
      senders: [{ email: "g@gmail.com", inbox: true, provider: "gmail" }],
      source: "canary-copy",
    });
    assert.equal(row.day, "2026-10-15");
    assert.equal(row.gToG, 100);
    assert.equal(row.gToMs, null);
  });
});
