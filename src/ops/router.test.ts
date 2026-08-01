import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import express from "express";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { OpsAuth } from "./auth.js";
import type { ManualRotationService } from "./manualRotation.js";
import { createOpsRouter } from "./router.js";

async function serverFixture() {
  const config = loadConfig({
    OPS_UI_ENABLED: "true",
    OPS_OWNER_TOKEN: "owner-token-that-is-long-enough",
    OPS_OPERATOR_TOKEN: "operator-token-that-is-long-enough",
    OPS_SESSION_SECRET: "session-secret-that-is-at-least-thirty-two-characters",
  });
  const auth = new OpsAuth({
    enabled: true,
    ownerUsername: "josh",
    operatorUsername: "cayden",
    ownerToken: config.opsOwnerToken,
    operatorToken: config.opsOperatorToken,
    sessionSecret: config.opsSessionSecret,
    sessionHours: 12,
  });
  const state = new StateStore(
    `/tmp/ops-router-${process.pid}-${Date.now()}-${Math.random()}.json`,
  );
  await state.load();
  state.upsertSpendApproval({
    id: "spend-1",
    requestKey: "spend-1",
    kind: "test",
    description: "Test spend",
    detail: {},
    requestedAt: new Date().toISOString(),
    status: "pending",
  });
  const rotation = {
    preview: async (email: string) => ({
      allowed: false,
      email,
      reasons: ["No safe replacement"],
      campaigns: [],
    }),
  } as unknown as ManualRotationService;
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(
    "/ops/api",
    createOpsRouter({
      config,
      auth,
      state,
      rotation,
      executeRotation: async (email) => ({
        preview: {
          allowed: false,
          email,
          reasons: ["blocked"],
          campaigns: [],
        },
        completed: false,
        rolledBack: false,
        errors: [],
      }),
      runtime: {
        deliverability: async () => ({
          monitor: { testsChecked: 1 },
          dns: { checked: 1, critical: [] },
          campaigns: { campaigns: [] },
        }),
        dns: async () => ({ checked: 1 }),
        campaigns: async () => ({ campaigns: [] }),
        reconnect: async () => ({ scanned: 1 }),
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return {
    base: `http://127.0.0.1:${address.port}/ops/api`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function login(
  base: string,
  username: "josh" | "cayden",
  accessKey: string,
) {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, accessKey }),
  });
  const body = (await response.json()) as {
    csrf: string;
    user: { role: string };
  };
  return {
    response,
    body,
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]!,
  };
}

describe("ops HTTP boundary", () => {
  it("enforces session, CSRF, operator role, and chat policy", async () => {
    const fixture = await serverFixture();
    try {
      assert.equal(
        (await fetch(`${fixture.base}/dashboard`)).status,
        401,
      );
      const session = await login(
        fixture.base,
        "cayden",
        "operator-token-that-is-long-enough",
      );
      assert.equal(session.response.status, 200);
      assert.equal(session.body.user.role, "operator");
      assert.match(session.response.headers.get("set-cookie") ?? "", /HttpOnly/);

      const dashboard = await fetch(`${fixture.base}/dashboard`, {
        headers: { cookie: session.cookie },
      });
      assert.equal(dashboard.status, 200);

      const approvals = await fetch(`${fixture.base}/approvals`, {
        headers: { cookie: session.cookie },
      });
      assert.equal(approvals.status, 403);

      const missingCsrf = await fetch(`${fixture.base}/chat`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "status" }),
      });
      assert.equal(missingCsrf.status, 403);

      const denied = await fetch(`${fixture.base}/chat`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "content-type": "application/json",
          "x-csrf-token": session.body.csrf,
        },
        body: JSON.stringify({ message: "buy five mailboxes" }),
      });
      const deniedBody = (await denied.json()) as { message: string };
      assert.equal(denied.status, 200);
      assert.match(deniedBody.message, /Cayden cannot buy/i);
    } finally {
      await fixture.close();
    }
  });

  it("allows only owner + CSRF + confirmation to decide pending spend", async () => {
    const fixture = await serverFixture();
    try {
      const session = await login(
        fixture.base,
        "josh",
        "owner-token-that-is-long-enough",
      );
      const noConfirm = await fetch(
        `${fixture.base}/approvals/spend-1/approve`,
        {
          method: "POST",
          headers: {
            cookie: session.cookie,
            "content-type": "application/json",
            "x-csrf-token": session.body.csrf,
          },
          body: JSON.stringify({ confirm: false }),
        },
      );
      assert.equal(noConfirm.status, 400);
      assert.equal(fixture.state.getSpendApproval("spend-1")?.status, "pending");

      const approved = await fetch(
        `${fixture.base}/approvals/spend-1/approve`,
        {
          method: "POST",
          headers: {
            cookie: session.cookie,
            "content-type": "application/json",
            "x-csrf-token": session.body.csrf,
          },
          body: JSON.stringify({ confirm: true }),
        },
      );
      assert.equal(approved.status, 200);
      assert.equal(
        fixture.state.getSpendApproval("spend-1")?.status,
        "approved",
      );
      assert.ok(
        fixture.state
          .listOpsAudit()
          .some((record) => record.action === "spend-approve-confirmed"),
      );
    } finally {
      await fixture.close();
    }
  });
});
