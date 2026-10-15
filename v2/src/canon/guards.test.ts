import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANON_CATALOG } from "./catalog.js";
import {
  CONTAMINATED_CANARY_LOCAL_PARTS,
  COPY_CANARY_FLEET_SIZE,
  DEFAULT_MIN_FLOOR,
  GOLIATH_CLIENT_ID,
  INSIGHT_CLIENT_ID,
  ISOLATION_DEADLINE_MS,
  SALESGLIDER_CLIENT_ID,
  SMARTLEAD_CONCURRENCY,
  SMARTLEAD_MAX_PER_MIN,
  TECHEVO_CLIENT_ID,
  TERL_HOLD_MS,
  WARMUP_DAYS,
} from "./constants.js";

function stop(decision: string, problem: string): string {
  return [
    "",
    "STOP — this reverses one of Josh's decisions.",
    `  Decision: ${decision}`,
    `  Problem:  ${problem}`,
    "This is not a bug. See DECISIONS.md for the reasoning and the tradeoff.",
    "Check with Josh before changing it. Do not delete this guard to go green.",
    "",
  ].join("\n");
}

const catalogDs = new Set(CANON_CATALOG.map((r) => r.d));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const srcFiles = walk(fileURLToPath(new URL("..", import.meta.url))).filter(
  (f) =>
    f.endsWith(".ts") &&
    !f.endsWith(".test.ts") &&
    !f.includes("/canon/catalog.ts"),
);
const srcBlob = srcFiles.map((f) => readFileSync(f, "utf8")).join("\n");

describe("v2 canon catalog covers CANON.md", () => {
  it("every D-number named in CANON.md is in the v2 catalog", async () => {
    const canon = await readFile(new URL("../../../CANON.md", import.meta.url), "utf8");
    const named = [...canon.matchAll(/\bD(\d+)\b/g)].map((m) => Number(m[1]));
    const missing = [...new Set(named)].filter((d) => !catalogDs.has(d)).sort((a, b) => a - b);
    assert.deepEqual(
      missing,
      [],
      stop(
        "D127 — CANON.md is the rules source",
        `CANON.md names decisions not in v2/src/canon/catalog.ts: ${missing.map((d) => `D${d}`).join(", ")}`,
      ),
    );
  });

  it("every omitted rule is listed in OMITTED.md", async () => {
    const omittedDoc = await readFile(new URL("../../OMITTED.md", import.meta.url), "utf8");
    const omitted = CANON_CATALOG.filter((r) => r.status === "omitted");
    const missing = omitted.filter((r) => !omittedDoc.includes(`D${r.d}`));
    assert.deepEqual(
      missing.map((r) => `D${r.d}`),
      [],
      stop("Josh review list", `omitted decisions missing from OMITTED.md: ${missing.map((r) => `D${r.d}`).join(", ")}`),
    );
  });

  it("catalog decision numbers are unique", () => {
    const dupes = CANON_CATALOG.map((r) => r.d).filter((d, i, all) => all.indexOf(d) !== i);
    assert.deepEqual(dupes, []);
  });
});

describe("ported live constants", () => {
  it("D50/D105: warmup is 21 days", () => {
    assert.equal(WARMUP_DAYS, 21);
  });
  it("D192: Insight ≠ SalesGlider", () => {
    assert.equal(INSIGHT_CLIENT_ID, 582890);
    assert.equal(SALESGLIDER_CLIENT_ID, 345263);
    assert.notEqual(INSIGHT_CLIENT_ID, SALESGLIDER_CLIENT_ID);
  });
  it("D237: PowerGRYD / Goliath / TechEvo ids stay", () => {
    assert.equal(GOLIATH_CLIENT_ID, 548611);
    assert.equal(TECHEVO_CLIENT_ID, 521881);
    assert.equal(DEFAULT_MIN_FLOOR, 40);
  });
  it("D54/D240: fleet size 10; aminarodriguez is released", () => {
    assert.equal(COPY_CANARY_FLEET_SIZE, 10);
    assert.ok((CONTAMINATED_CANARY_LOCAL_PARTS as readonly string[]).includes("aminarodriguez"));
  });
  it("A8 / Josh SLA: 30-minute isolation deadline", () => {
    assert.equal(ISOLATION_DEADLINE_MS, 30 * 60 * 1000);
  });
  it("D219: TERRL hold is 24h", () => {
    assert.equal(TERL_HOLD_MS, 24 * 60 * 60 * 1000);
  });
  it("D257: Smartlead limiter is 150/min concurrency 2", () => {
    assert.equal(SMARTLEAD_MAX_PER_MIN, 150);
    assert.equal(SMARTLEAD_CONCURRENCY, 2);
  });
});

describe("retired machinery stays out of v2", () => {
  it("D221: no generic send-clock", () => {
    assert.doesNotMatch(srcBlob, /genericSendRest|GenericSendRest/, stop("D221", "generic send-clock returned"));
  });
  it("D130: no recovery-swap / activeSwaps", () => {
    assert.doesNotMatch(srcBlob, /activeSwaps|recovery-swap/, stop("D130", "recovery-swap returned"));
  });
  it("D148/D157: never writes bounce_autopause_threshold or pauses from bounce", () => {
    assert.doesNotMatch(srcBlob, /bounce_autopause_threshold/, stop("D157", "bounce autopause write returned"));
    assert.doesNotMatch(srcBlob, /shouldAutostopCampaignForBounce/, stop("D88", "pause bands returned"));
  });
  it("D268: no Allow-generics card", () => {
    assert.doesNotMatch(srcBlob, /Allow-generics|genericBackfillApprovals/, stop("D268", "Allow card returned"));
  });
  it("D255: no Insight in-body close writer", () => {
    assert.doesNotMatch(
      srcBlob,
      /writeInsightClose|inBodyClose/,
      stop("D255", "Insight in-body close writer returned"),
    );
  });
  it("D51: no placement rotation pull", () => {
    assert.doesNotMatch(srcBlob, /placementRotation/, stop("D51", "placement rotation returned"));
  });
});

describe("ported canon that Josh said v2 was missing", () => {
  it("D94 reconnect and D257 limiter live in v2 src", () => {
    assert.match(srcBlob, /kind:\s*"reconnect"/, stop("D94", "reconnect intended action missing"));
    assert.match(srcBlob, /SMARTLEAD_MAX_PER_MIN/, stop("D257", "limiter constant missing from src"));
  });
  it("D152/D168 word hunt classifies gift-bait", () => {
    assert.match(srcBlob, /gift-or-experience-offer/, stop("D168", "line-job classifier missing"));
    assert.match(srcBlob, /I'd like to offer/, stop("D171", "offer lead-in missing"));
  });
  it("ESP-to-ESP matrix and QA lease exist", () => {
    assert.match(srcBlob, /gToG|G_G/, stop("ESP matrix", "G→G lane missing"));
    assert.match(srcBlob, /acquireQaLease/, stop("QA lease", "lease missing"));
  });
  it("D273 drops cross-ESP rate pairs", () => {
    assert.doesNotMatch(
      srcBlob,
      /gToMs|msToG|G_MS|MS_G/,
      stop("D273", "cross-ESP G→MS / MS→G lanes returned"),
    );
  });
  it("D274/D275/D276/D277 live in v2 src", () => {
    assert.match(srcBlob, /enable_ai_esp_matching|enableAiEspMatching/, stop("D274", "ESP matching check missing"));
    assert.match(srcBlob, /send_as_plain_text|sendAsPlainText/, stop("D275", "plain text check missing"));
    assert.match(srcBlob, /inStaffingHours|quiet_hours/, stop("D276", "quiet hours missing"));
    assert.doesNotMatch(
      srcBlob,
      /a pair of AirPods if you would like/,
      stop("D277", "AirPods still appears as a REPLACE WITH substitute"),
    );
    assert.match(srcBlob, /\\bTJ\\b/, stop("D277", "TJ ban missing from isBannedCopySwap"));
  });
});

describe("shadow is structural, not a comment", () => {
  it("clients never mutate via PUT/PATCH/DELETE; SmartDelivery list is POST spam-test/report", () => {
    const clients = srcFiles.filter(
      (f) => f.includes("/clients/") && !f.endsWith("/http.ts"),
    );
    const blob = clients.map((f) => readFileSync(f, "utf8")).join("\n");
    assert.doesNotMatch(
      blob,
      /method:\s*["'](PUT|PATCH|DELETE)["']/,
      stop("SHADOW", "a v2 client issues a mutating HTTP method"),
    );
    const sd = readFileSync(
      fileURLToPath(new URL("../clients/smartdelivery.ts", import.meta.url)),
      "utf8",
    );
    assert.match(
      sd,
      /spam-test\/report/,
      stop("SmartDelivery list", "listTests must POST /api/v1/spam-test/report"),
    );
    assert.doesNotMatch(
      sd,
      /\/api\/spam-tests|spam-tests\?api_key/,
      stop("SmartDelivery list", "the unversioned collection path 404s — use spam-test/report"),
    );
    assert.doesNotMatch(
      sd,
      /spam-test\/(manual|schedule|delete)/,
      stop("SHADOW", "smartdelivery reader must not create/schedule/delete tests"),
    );
  });
});
