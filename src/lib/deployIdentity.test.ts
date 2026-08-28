import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deployIdentityLine,
  deployIdentityProblem,
  readDeployIdentity,
} from "./deployIdentity.js";

describe("D149 — deploy identity", () => {
  it("off Railway: identified as such, never a problem", () => {
    const id = readDeployIdentity({});
    assert.equal(id.onRailway, false);
    assert.equal(deployIdentityProblem(id), null);
    assert.match(deployIdentityLine(id), /not on Railway/);
  });

  it("a Railway build with no commit metadata is the stale-snapshot signature", () => {
    const id = readDeployIdentity({ RAILWAY_DEPLOYMENT_ID: "abc-123" });
    assert.equal(id.onRailway, true);
    assert.match(deployIdentityProblem(id) ?? "", /no git commit metadata/);
    assert.match(deployIdentityLine(id), /MISSING/);
  });

  it("a build from a branch other than main is a problem", () => {
    const id = readDeployIdentity({
      RAILWAY_DEPLOYMENT_ID: "abc-123",
      RAILWAY_GIT_COMMIT_SHA: "27460b6deadbeef",
      RAILWAY_GIT_BRANCH: "cursor/stale-thing",
    });
    assert.match(deployIdentityProblem(id) ?? "", /not main/);
  });

  it("a main-branch push build is clean", () => {
    const id = readDeployIdentity({
      RAILWAY_ENVIRONMENT_NAME: "production",
      RAILWAY_DEPLOYMENT_ID: "abc-123",
      RAILWAY_GIT_COMMIT_SHA: "27460b6deadbeef",
      RAILWAY_GIT_BRANCH: "main",
    });
    assert.equal(deployIdentityProblem(id), null);
    assert.match(deployIdentityLine(id), /commit 27460b6 branch main/);
  });
});
