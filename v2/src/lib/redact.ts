/**
 * Never persist, log, or serve API keys / tokens. SmartDelivery errors
 * previously stored the full request URL including `api_key`.
 */

const SECRET_QUERY =
  /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|secret|password|authorization|auth)=)[^&\s"'`<>]+/gi;

const SECRET_ASSIGN =
  /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)["']?\s*[:=]\s*["']?)[^&"'`\s,}\]]+/gi;

const BEARER = /(Bearer\s+)[A-Za-z0-9._\-+=/]+/gi;

const URL_RE = /https?:\/\/[^\s"'<>\\]+/gi;

export function redactSecrets(input: unknown): string {
  let out = String(input ?? "");
  out = out.replace(BEARER, "$1REDACTED");
  out = out.replace(SECRET_QUERY, "$1REDACTED");
  out = out.replace(SECRET_ASSIGN, "$1REDACTED");
  return out;
}

/** Pathname only — no host, no query. Used so /health never echoes upstream URLs. */
export function urlPathOnly(raw: string): string {
  const trimmed = raw.replace(/[),.;]+$/, "");
  try {
    const u = new URL(trimmed);
    return u.pathname || "[upstream]";
  } catch {
    return "[upstream]";
  }
}

export function stripUpstreamUrls(input: unknown): string {
  return String(input ?? "").replace(URL_RE, (match) => urlPathOnly(match));
}

export function safeErrorText(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
  return stripUpstreamUrls(redactSecrets(raw));
}

export function requestLabel(method: string, url: string): string {
  return `${method.toUpperCase()} ${urlPathOnly(url)}`;
}

/**
 * Leftover unredacted secrets. `api_key=REDACTED` is clean — the next
 * character is `R`. Never use this to print the matching text.
 */
const UNREDACTED_API_KEY = /api_key=[^&\s\[R]/i;
const UNREDACTED_QUERY =
  /(?:access[_-]?token|refresh[_-]?token|(?:^|[?&])token|secret|password)=[^&\s\[R]/i;
const UNREDACTED_ASSIGN =
  /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|(?<![A-Za-z_])token|secret|password)["']?\s*[:=]\s*["'][^R"'`\s]/i;
const UNREDACTED_BEARER = /Bearer\s+(?!REDACTED)[A-Za-z0-9._\-+=/]/i;

export function looksUnredactedSecret(input: unknown): boolean {
  const text = String(input ?? "");
  if (!text) return false;
  return (
    UNREDACTED_API_KEY.test(text) ||
    UNREDACTED_QUERY.test(text) ||
    UNREDACTED_ASSIGN.test(text) ||
    UNREDACTED_BEARER.test(text)
  );
}

export interface SecretLeftoverCounts {
  stageHealth: number;
  findings: number;
  jsonPayloads: number;
}

export function tallySecretLeftovers(rows: {
  stageHealth?: readonly unknown[];
  findings?: readonly unknown[];
  jsonPayloads?: readonly unknown[];
}): SecretLeftoverCounts {
  const n = (arr?: readonly unknown[]) =>
    (arr ?? []).filter((value) => looksUnredactedSecret(value)).length;
  return {
    stageHealth: n(rows.stageHealth),
    findings: n(rows.findings),
    jsonPayloads: n(rows.jsonPayloads),
  };
}

/** One log line — integers only, never values. */
export function formatSecretScrubLog(counts: SecretLeftoverCounts): string {
  const total = counts.stageHealth + counts.findings + counts.jsonPayloads;
  return `[v2] leftover secrets after scrub: stage_health=${counts.stageHealth} findings=${counts.findings} json_payloads=${counts.jsonPayloads} total=${total}`;
}
