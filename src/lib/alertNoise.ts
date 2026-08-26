const TIMEOUT_NOISE =
  /timed?\s*out|timeout|operation was aborted|\bAbortError\b|\bTimeoutError\b/i;

/** Cloudflare/origin gateway timeouts and other upstream 5xx. */
const UPSTREAM_5XX_NOISE = /\bHTTP\s*5\d\d\b/i;

function isTimeoutNoise(message: string): boolean {
  return TIMEOUT_NOISE.test(message);
}

function isUpstream5xxNoise(message: string): boolean {
  return UPSTREAM_5XX_NOISE.test(message);
}

function isHttpRateLimitNoise(message: string): boolean {
  return (
    /\bHTTP\s*429\b/i.test(message) ||
    /\b429\b/.test(message) ||
    /rate[\s_-]*limit(?:ed|ing)?/i.test(message) ||
    /too many requests/i.test(message)
  );
}

/**
 * Errors that are transient API throttling / timeouts / upstream 5xx and
 * should not page Slack. Request aborts and Cloudflare 524s count here —
 * the next cron pass retries them.
 */
export function isRateLimitNoise(message: string): boolean {
  return (
    isHttpRateLimitNoise(message) ||
    isTimeoutNoise(message) ||
    isUpstream5xxNoise(message)
  );
}

/**
 * Pending/denied spend or destructive approvals already notify via the
 * spend gateway; repeating them on every remediation cron is not actionable.
 */
export function isApprovalGateNoise(message: string): boolean {
  return (
    /awaiting approval/i.test(message) ||
    /waiting on spend approval/i.test(message) ||
    /see\s+GET\s+\/approvals/i.test(message)
  );
}

/**
 * SmartDelivery test ids that no longer exist (deleted, expired, or stopped
 * and purged). Monitor/remediation still hold them in local state briefly —
 * skip Slack paging; the next list/reconcile pass drops them.
 */
export function isMissingSpamTestNoise(message: string): boolean {
  return /spam test not found|placement test not found|spam[_ -]?test.*\bnot found\b/i.test(
    message,
  );
}

/**
 * Remediation intentionally left a mailbox unheld after a campaign removal
 * failed so the next cron retries. The specific `remove …` row is the
 * actionable error; this summary is redundant in Slack.
 */
export function isRetryRemovalNoise(message: string): boolean {
  return /left unheld so the next run retries|campaign removal\(s\) failed/i.test(
    message,
  );
}

/**
 * D41 burn checklist refused teardown — blacklist alone is not enough.
 * Working as designed; do not page Slack or treat as a remediable error.
 */
export function isBurnChecklistNoise(message: string): boolean {
  return /burn checklist not ready|blacklist alone is not enough/i.test(
    message,
  );
}

/**
 * SmartDelivery rejected sender_accounts that Smartlead still listed on the
 * campaign (membership lag). Scan retries next pass; do not page Slack.
 */
export function isSenderNotInCampaignNoise(message: string): boolean {
  return /sender email accounts?.+not used in the campaign/i.test(message);
}

/** Rate limits/timeouts + approval gates + gone tests — skip Slack paging. */
export function isBenignOpsNoise(message: string): boolean {
  return (
    isRateLimitNoise(message) ||
    isApprovalGateNoise(message) ||
    isMissingSpamTestNoise(message) ||
    isRetryRemovalNoise(message) ||
    isBurnChecklistNoise(message) ||
    isSenderNotInCampaignNoise(message)
  );
}

/**
 * Turn a technical ops error into a short plain-English Slack line.
 * Keeps mailbox / campaign identifiers when present; drops raw HTTP jargon.
 */
export function humanizeAlertError(message: string): string {
  const raw = String(message || "").trim();
  if (!raw) return "Something went wrong.";

  const rateLimited = isHttpRateLimitNoise(raw);
  const timedOut = isTimeoutNoise(raw);
  const listAccounts = /list\s+accounts/i.test(raw);
  const listCampaigns = /list\s+campaigns/i.test(raw);
  const bounceStats = /bounce\s+stats/i.test(raw);
  const removeMatch = raw.match(
    /remove\s+(\S+)\s+from\s+campaign\s+(\d+)/i,
  );
  const swapMatch = raw.match(/swap-in\s+(\S+)\s+←\s+(\S+)/i);
  const getAccount = raw.match(/get\s+account\s+(\d+)/i);
  const campaignAccounts = raw.match(/campaign\s+(\d+)\s+accounts/i);

  if (/insufficient sequence credits|insufficient credits/i.test(raw)) {
    return "SmartDelivery is out of sequence credits — top up the SmartDelivery wallet to create more placement tests.";
  }

  if (
    /no seed accounts found|seed accounts found for the provided provider/i.test(
      raw,
    )
  ) {
    return "SmartDelivery has no seed inboxes for the provider IDs we sent — check PROVIDER_IDS or SmartDelivery seed capacity.";
  }

  if (isMissingSpamTestNoise(raw)) {
    return "A SmartDelivery placement test is gone (deleted or expired). Skipping it.";
  }

  if (isRetryRemovalNoise(raw)) {
    return "Could not take a mailbox off every campaign — left it unheld so the next run retries.";
  }

  if (isBurnChecklistNoise(raw)) {
    return "Blacklist alone is not enough to burn that domain — waiting for a same-ESP placement fail or bounce over threshold.";
  }

  if (isSenderNotInCampaignNoise(raw)) {
    return "SmartDelivery says some senders are not on that campaign yet (membership lag). We'll retry next scan.";
  }

  if (bounceStats && /\b404\b/i.test(raw)) {
    return "Couldn't load bounce stats from Smartlead (the stats endpoint was unavailable).";
  }
  if (bounceStats && timedOut) {
    return "Couldn't load bounce stats from Smartlead in time (the mailbox health metrics call timed out). We'll retry next run.";
  }
  if (bounceStats && isUpstream5xxNoise(raw)) {
    return "Couldn't load bounce stats from Smartlead (temporary gateway/server error). We'll retry next run.";
  }
  if (timedOut) {
    return "A Smartlead request timed out. We'll retry automatically.";
  }

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
