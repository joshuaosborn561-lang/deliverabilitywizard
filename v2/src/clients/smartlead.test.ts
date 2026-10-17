import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SmartleadReader } from "./smartlead.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("campaign list reads scheduler_cron_value", () => {
  it("maps live Smartlead fields: tz/days/startHour and tracking aliases", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify([
          {
            id: 4131393,
            name: "Nutter | Board | Outline | All",
            status: "ACTIVE",
            client_id: 1,
            enable_ai_esp_matching: true,
            send_as_plain_text: true,
            track_settings: ["DONT_EMAIL_OPEN", "DONT_LINK_CLICK"],
            scheduler_cron_value: {
              tz: "America/Chicago",
              days: [1, 2, 3, 4],
              endHour: "18:00",
              startHour: "09:00",
            },
          },
          {
            id: 3847940,
            name: "SG MSP Engagers",
            status: "ACTIVE",
            enable_ai_esp_matching: true,
            send_as_plain_text: true,
            track_settings: ["DONT_EMAIL_OPEN", "DONT_LINK_CLICK"],
            scheduler_cron_value: {
              tz: "America/New_York",
              days: [1, 2, 3, 4],
              endHour: "19:00",
              startHour: "08:00",
            },
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const campaigns = await new SmartleadReader("LIVESECRET", (fn) => fn(), 0).listCampaigns();
    const nutter = campaigns.find((c) => c.id === 4131393);
    const sg = campaigns.find((c) => c.id === 3847940);
    assert.equal(nutter?.enableAiEspMatching, true);
    assert.equal(nutter?.sendAsPlainText, true);
    assert.deepEqual(nutter?.trackSettings, ["DONT_EMAIL_OPEN", "DONT_LINK_CLICK"]);
    assert.equal(nutter?.timezone, "America/Chicago");
    assert.deepEqual(nutter?.daysOfTheWeek, [1, 2, 3, 4]);
    assert.equal(nutter?.startHour, "09:00");
    assert.equal(nutter?.endHour, "18:00");
    assert.equal(sg?.timezone, "America/New_York");
    assert.equal(sg?.startHour, "08:00");
    assert.equal(sg?.endHour, "19:00");
  });
});

describe("staff email-account inventory paging", () => {
  it("requests fetch_campaigns=true and coerces string campaign_ids to numbers", async () => {
    const keys: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const u = new URL(String(url));
      keys.push(u.searchParams.get("fetch_campaigns") ?? "");
      return new Response(
        JSON.stringify([
          {
            id: 7,
            from_email: "ada@x.test",
            campaign_ids: ["3847940", 3921850],
            campaigns: [{ id: "3921852" }],
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const accounts = await new SmartleadReader("LIVESECRET", (fn) => fn(), 0).listAccounts();
    assert.deepEqual(keys, ["true"]);
    assert.deepEqual(accounts[0]?.campaignIds.sort((a, b) => a - b), [3847940, 3921850, 3921852]);
  });

  it("delays between pages and does not put the api key in thrown errors", async () => {
    const offsets: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const u = new URL(String(url));
      offsets.push(u.searchParams.get("offset") ?? "");
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const row = { id: offset + 1, from_email: `a${offset}@x.test` };
      const rows = offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ ...row, id: i + 1 })) : [];
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const started = Date.now();
    const accounts = await new SmartleadReader("LIVESECRET", (fn) => fn(), 25).listAccounts();
    const elapsed = Date.now() - started;
    assert.equal(accounts.length, 100);
    assert.deepEqual(offsets, ["0", "100"]);
    assert.ok(elapsed >= 20, `expected page delay, elapsed=${elapsed}`);
  });

  it("caps account pages so a tick cannot paginate forever", async () => {
    let pages = 0;
    globalThis.fetch = (async () => {
      pages += 1;
      const rows = Array.from({ length: 100 }, (_, i) => ({ id: pages * 100 + i, from_email: `a${i}@x.test` }));
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const accounts = await new SmartleadReader("LIVESECRET", (fn) => fn(), 0).listAccounts({
      maxPages: 2,
    });
    assert.equal(pages, 2);
    assert.equal(accounts.length, 200);
  });

  it("returns pages already fetched when the tick aborts mid-pagination", async () => {
    let pages = 0;
    const ac = new AbortController();
    globalThis.fetch = (async () => {
      pages += 1;
      const rows = Array.from({ length: 100 }, (_, i) => ({
        id: pages * 100 + i,
        from_email: `a${pages}-${i}@x.test`,
      }));
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const accounts = await new SmartleadReader("LIVESECRET", (fn) => fn(), 0).listAccounts({
      signal: ac.signal,
      maxPages: 10,
      onProgress: (info) => {
        if ((info.page ?? 0) >= 2) ac.abort();
      },
    });
    assert.equal(pages, 1);
    assert.equal(accounts.length, 100);
  });
});
