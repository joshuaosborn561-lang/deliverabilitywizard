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

export function isolationActionValue(kind: string, id: string, decision: "approve" | "deny"): string {
  return `${kind}:${id}:${decision}`;
}

export function parseIsolationActionValue(
  value: string,
): { kind: string; id: string; decision: "approve" | "deny" } | undefined {
  const [kind, id, decision] = value.split(":");
  if (!kind || !id || (decision !== "approve" && decision !== "deny")) return undefined;
  return { kind, id, decision };
}
