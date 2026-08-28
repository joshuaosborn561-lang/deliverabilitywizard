/**
 * D149 — alerts and watches live on Railway, not in a chat session.
 * Railway injects RAILWAY_GIT_* metadata into every build made from the
 * connected GitHub repo. A deployment with no commit metadata is exactly
 * what the 2026-08-27 stale-snapshot redeployer produced (rebuilds of a
 * deleted branch's snapshot kept overwriting main), so the app reads its
 * own identity at boot, logs it, publishes it on /health, and pages Slack
 * when it is wrong. Known limit: a stale snapshot runs OLD code, which
 * cannot self-report — this catches a wrong source whenever NEW code
 * boots, and makes "which build is live?" a curl instead of a dashboard
 * dig.
 */

export interface DeployIdentity {
  onRailway: boolean;
  sha: string | null;
  branch: string | null;
  deploymentId: string | null;
}

export function readDeployIdentity(
  env: NodeJS.ProcessEnv = process.env,
): DeployIdentity {
  const sha = env.RAILWAY_GIT_COMMIT_SHA?.trim() || null;
  const branch = env.RAILWAY_GIT_BRANCH?.trim() || null;
  const deploymentId = env.RAILWAY_DEPLOYMENT_ID?.trim() || null;
  const onRailway = Boolean(
    deploymentId || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID,
  );
  return { onRailway, sha, branch, deploymentId };
}

/** One human line for boot logs and /health. */
export function deployIdentityLine(id: DeployIdentity): string {
  if (!id.onRailway) return "not on Railway (no RAILWAY_* env)";
  return `commit ${id.sha ? id.sha.slice(0, 7) : "MISSING"} branch ${id.branch ?? "unknown"} deployment ${id.deploymentId ?? "unknown"}`;
}

/** Null when this build is what production should be running. */
export function deployIdentityProblem(id: DeployIdentity): string | null {
  if (!id.onRailway) return null;
  if (!id.sha) {
    return "this build carries no git commit metadata — it did not come from a GitHub push (a stale-snapshot redeploy looks exactly like this)";
  }
  if (id.branch && id.branch !== "main") {
    return `this build came from branch \`${id.branch}\`, not main`;
  }
  return null;
}
