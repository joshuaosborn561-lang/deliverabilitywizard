import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpsAuth } from "./auth.js";

function auth() {
  return new OpsAuth({
    enabled: true,
    ownerUsername: "josh",
    operatorUsername: "cayden",
    ownerToken: "owner-token-that-is-long-enough",
    operatorToken: "operator-token-that-is-long-enough",
    sessionSecret: "session-secret-that-is-at-least-thirty-two-characters",
    sessionHours: 12,
  });
}

describe("OpsAuth", () => {
  it("maps allowlisted users to separate roles", () => {
    const service = auth();
    assert.equal(
      service.authenticate("josh", "owner-token-that-is-long-enough")?.role,
      "owner",
    );
    assert.equal(
      service.authenticate("cayden", "operator-token-that-is-long-enough")
        ?.role,
      "operator",
    );
    assert.equal(service.authenticate("other", "operator-token-that-is-long-enough"), null);
    assert.equal(service.authenticate("cayden", "wrong"), null);
  });

  it("signs, verifies and expires sessions", () => {
    const service = auth();
    const session = service.authenticate(
      "cayden",
      "operator-token-that-is-long-enough",
    )!;
    const signed = service.sign(session);
    assert.equal(service.verify(signed)?.username, "cayden");
    assert.equal(service.verify(`${signed}tampered`), null);
    assert.equal(
      service.verify(
        service.sign({ ...session, expiresAt: Date.now() - 1 }),
      ),
      null,
    );
  });

  it("stays disabled until all independent secrets are strong", () => {
    const service = new OpsAuth({
      enabled: true,
      ownerUsername: "josh",
      operatorUsername: "cayden",
      ownerToken: "",
      operatorToken: "",
      sessionSecret: "",
      sessionHours: 12,
    });
    assert.equal(service.isConfigured(), false);
    assert.match(service.configurationError()!, /SESSION_SECRET/);
  });
});
