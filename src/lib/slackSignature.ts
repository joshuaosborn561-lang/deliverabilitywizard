import { createHmac, timingSafeEqual } from "node:crypto";

export function slackSignatureValid(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  nowMs?: number;
}): boolean {
  if (!input.signingSecret || !input.timestamp || !input.signature) return false;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowMs ?? Date.now();
  if (Math.abs(now / 1000 - ts) > 60 * 5) return false;
  const base = `v0:${input.timestamp}:${input.rawBody}`;
  const digest = `v0=${createHmac("sha256", input.signingSecret).update(base).digest("hex")}`;
  const expected = Buffer.from(digest);
  const got = Buffer.from(input.signature);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

export function isolationActionValue(
  kind: string,
  id: string,
  decision: "approve" | "deny" | "edit",
): string {
  return `${kind}:${id}:${decision}`;
}

export function parseIsolationActionValue(
  value: string,
): { kind: string; id: string; decision: "approve" | "deny" | "edit" } | undefined {
  const lastColon = value.lastIndexOf(":");
  if (lastColon <= 0) return undefined;
  const decision = value.slice(lastColon + 1);
  const rest = value.slice(0, lastColon);
  const firstColon = rest.indexOf(":");
  if (firstColon <= 0) return undefined;
  const kind = rest.slice(0, firstColon);
  const id = rest.slice(firstColon + 1);
  if (
    !kind ||
    !id ||
    (decision !== "approve" && decision !== "deny" && decision !== "edit")
  ) {
    return undefined;
  }
  return { kind, id, decision };
}
