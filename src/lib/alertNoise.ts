/** Errors that are transient API throttling and should not page Slack. */
export function isRateLimitNoise(message: string): boolean {
  return (
    /\bHTTP\s*429\b/i.test(message) ||
    /\b429\b/.test(message) ||
    /rate[\s_-]*limit(?:ed|ing)?/i.test(message) ||
    /too many requests/i.test(message)
  );
}

/**
 * Turn a technical ops error into a short plain-English Slack line.
 * Keeps mailbox / campaign identifiers when present; drops raw HTTP jargon.
 */
export function humanizeAlertError(message: string): string {
  const raw = String(message || "").trim();
  if (!raw) return "Something went wrong.";

  const rateLimited = isRateLimitNoise(raw);
  const listAccounts = /list\s+accounts/i.test(raw);
  const listCampaigns = /list\s+campaigns/i.test(raw);
  const bounceStats = /bounce\s+stats/i.test(raw);
  const removeMatch = raw.match(
    /remove\s+(\S+)\s+from\s+campaign\s+(\d+)/i,
  );
  const swapMatch = raw.match(/swap-in\s+(\S+)\s+←\s+(\S+)/i);
  const getAccount = raw.match(/get\s+account\s+(\d+)/i);
  const campaignAccounts = raw.match(/campaign\s+(\d+)\s+accounts/i);

  if (rateLimited && listAccounts) {
    return "Smartlead rate-limited us while loading the mailbox list. Nothing was changed; we'll try again next run.";
  }
  if (rateLimited && listCampaigns) {
    return "Smartlead rate-limited us while loading campaigns. Nothing was changed; we'll try again next run.";
  }
  if (rateLimited && removeMatch) {
    return `Smartlead rate-limited us while taking \`${removeMatch[1]}\` off a campaign. We'll retry next run.`;
  }
  if (rateLimited && swapMatch) {
    return `Smartlead rate-limited us while covering \`${swapMatch[1]}\` with \`${swapMatch[2]}\`. We'll retry next run.`;
  }
  if (rateLimited && campaignAccounts) {
    return `Smartlead rate-limited us while reading mailboxes on campaign ${campaignAccounts[1]}. We'll retry next run.`;
  }
  if (rateLimited && getAccount) {
    return `Smartlead rate-limited us while reading mailbox ${getAccount[1]}. We'll retry next run.`;
  }
  if (rateLimited) {
    return "Smartlead is rate-limiting us right now. We'll retry automatically.";
  }

  if (bounceStats && /\b404\b/i.test(raw)) {
    return "Couldn't load bounce stats from Smartlead (the stats endpoint was unavailable).";
  }
  if (/\bHTTP\s*404\b/i.test(raw) || /\b404\b/.test(raw)) {
    return raw
      .replace(/\bHTTP\s*404\b/gi, "not found")
      .replace(/\b404\b/g, "not found");
  }
  if (/\bHTTP\s*5\d\d\b/i.test(raw)) {
    return "Smartlead had a temporary server error. We'll retry automatically.";
  }

  // Strip leftover "HTTP NNN" so Slack stays readable.
  return raw.replace(/\bHTTP\s*(\d{3})\b/gi, "error $1");
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
