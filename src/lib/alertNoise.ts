/** Errors that are transient API throttling and should not page Slack. */
export function isRateLimitNoise(message: string): boolean {
  return (
    /\bHTTP\s*429\b/i.test(message) ||
    /\b429\b/.test(message) ||
    /rate[\s_-]*limit(?:ed|ing)?/i.test(message) ||
    /too many requests/i.test(message)
  );
}

/** Stable, low-cardinality category for reconnect alert deduplication. */
export function reconnectFailureCategory(message: string): string {
  if (isRateLimitNoise(message)) return "rate-limit";
  if (
    /oauth|reauth|reconnect|aadsts|mfa|multi-factor|admin consent/i.test(
      message,
    )
  ) {
    return "manual-oauth";
  }
  return message
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "url")
    .replace(/\d+/g, "#")
    .replace(/[^a-z#]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "unknown";
}
