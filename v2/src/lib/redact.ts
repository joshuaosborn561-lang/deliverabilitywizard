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
