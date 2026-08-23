import { createHmac, timingSafeEqual } from "node:crypto";

export type SlackActionDecision = "approve" | "deny";

export function publicBaseUrlFromEnv(env: NodeJS.ProcessEnv): string {
  const explicit = env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const railway = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway.replace(/\/$/, "")}`;
  return "https://deliverabilitywizard-production.up.railway.app";
}

export function slackActionHref(input: {
  baseUrl: string;
  secret: string;
  id: string;
  decision: SlackActionDecision;
  nowMs?: number;
  ttlMs?: number;
}): string {
  const exp = (input.nowMs ?? Date.now()) + (input.ttlMs ?? 14 * 24 * 60 * 60 * 1000);
  const sig = signSlackAction({
    secret: input.secret,
    id: input.id,
    decision: input.decision,
    exp,
  });
  const url = new URL("/slack/action", input.baseUrl);
  url.searchParams.set("id", input.id);
  url.searchParams.set("decision", input.decision);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return url.toString();
}

export function signSlackAction(input: {
  secret: string;
  id: string;
  decision: SlackActionDecision;
  exp: number;
}): string {
  return createHmac("sha256", input.secret)
    .update(`${input.id}:${input.decision}:${input.exp}`)
    .digest("hex");
}

export function verifySlackActionLink(input: {
  secret: string;
  id: string;
  decision: string;
  exp: string;
  sig: string;
  nowMs?: number;
}): { ok: true; decision: SlackActionDecision } | { ok: false; reason: string } {
  if (!input.secret) return { ok: false, reason: "Signing secret is not configured." };
  if (!input.id) return { ok: false, reason: "Missing request id." };
  if (input.decision !== "approve" && input.decision !== "deny") {
    return { ok: false, reason: "Decision must be approve or deny." };
  }
  const exp = Number(input.exp);
  if (!Number.isFinite(exp) || exp <= (input.nowMs ?? Date.now())) {
    return { ok: false, reason: "That link has expired. Ask me to send a new button." };
  }
  const expected = Buffer.from(
    signSlackAction({
      secret: input.secret,
      id: input.id,
      decision: input.decision,
      exp,
    }),
  );
  const got = Buffer.from(input.sig ?? "");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    return { ok: false, reason: "That link is not valid." };
  }
  return { ok: true, decision: input.decision };
}

export function slackInstallHref(input: {
  clientId: string;
  redirectUri: string;
  scopes?: string[];
}): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", (input.scopes ?? ["chat:write", "chat:write.public"]).join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  return url.toString();
}
