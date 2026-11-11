import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { resolveAccountClient, SmartleadClient } from "./smartlead.js";

/**
 * Per-client Smartlead API keys are being deleted. The wizard must run on
 * the single master key (SMARTLEAD_API_KEY) and attribute every campaign /
 * mailbox to its client from the Smartlead client_id the master account
 * returns — never from a per-client credential.
 */

const MASTER = "master-key-fixture";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureFetch(body: unknown): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return urls;
}

describe("master-key-only Smartlead access", () => {
  it("config takes only SMARTLEAD_API_KEY, ignoring any per-client key env", () => {
    const config = loadConfig({
      SMARTLEAD_API_KEY: MASTER,
      SMARTLEAD_API_KEY_GOLIATH: "",
      SMARTLEAD_CLIENT_API_KEY: "",
      GOLIATH_SMARTLEAD_API_KEY: "",
    } as NodeJS.ProcessEnv);
    assert.equal(config.smartleadApiKey, MASTER);
    // SmartDelivery falls back to the same master key when unset.
    assert.equal(config.smartDeliveryApiKey, MASTER);
  });

  it("reads and writes sub-client campaigns with the master key", async () => {
    const urls = captureFetch({ id: 3921647, client_id: 582890 });
    const client = new SmartleadClient(MASTER);
    await client.getCampaign(3921647);
    await client.getLeadMessageHistory(3921647, 42);
    await client.listClients();
    await client.getCampaignStatistics(3921647);
    await client.setCampaignClientId(3921647, 582890);
    assert.ok(urls.length >= 5);
    for (const raw of urls) {
      const url = new URL(raw);
      assert.equal(url.searchParams.get("api_key"), MASTER, raw.replace(MASTER, "<master>"));
      assert.equal(url.searchParams.getAll("api_key").length, 1);
    }
  });

  it("attributes a mailbox to its client from campaign client_id with no client key", () => {
    const clients = new Map([[582890, { id: 582890, name: "Goliath" }]]);
    const viaCampaign = resolveAccountClient(
      { id: 1, from_email: "a@x.com", campaigns: [{ id: 3921647 }] } as never,
      new Map([[3921647, 582890]]),
      clients,
    );
    assert.equal(viaCampaign.clientId, 582890);
    const unowned = resolveAccountClient(
      { id: 2, from_email: "b@x.com" } as never,
      new Map(),
      clients,
    );
    assert.equal(unowned.clientId, null);
  });

  it("no runtime source reads a per-client Smartlead key", () => {
    const root = new URL("..", import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) files.push(path);
      }
    };
    walk(root);
    const perClientKey =
      /smartlead_api_key|client_api_key|SMARTLEAD_API_KEY_[A-Z]|[A-Z]+_SMARTLEAD_API_KEY|clientApiKey|client\.api_key/;
    const constructions: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, perClientKey, relative(root, file));
      for (const match of text.matchAll(/new SmartleadClient\(([^,)]*)/g)) {
        constructions.push(`${relative(root, file)}:${match[1]!.trim()}`);
      }
    }
    assert.deepEqual(constructions, [
      'index.ts:config.smartleadApiKey || "missing"',
    ]);
  });
});
