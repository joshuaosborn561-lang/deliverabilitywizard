export type FailureClass =
  | "api_validation"
  | "stale_endpoint"
  | "report_fanout"
  | "type_error"
  | "auth_access"
  | "noise"
  | "unknown";

export interface ClassifiedFailure {
  class: FailureClass;
  /** Stable key for cooldown / dedupe. */
  fingerprint: string;
  /** True → launch Cursor draft-PR remediator (never spend/delete/deploy). */
  autoRemediate: boolean;
  summary: string;
  raw: string;
}

/**
 * Map runtime error text into a remediation class.
 * Noise (429-only, SURBL) never launches a Cursor agent.
 */
export function classifyFailure(
  source: string,
  error: unknown,
): ClassifiedFailure {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  const text = `${source}: ${raw}`.slice(0, 2000);
  const lower = text.toLowerCase();

  if (
    /http 429|rate.?limit|too many requests|econnreset|etimedout|socket hang up/i.test(
      lower,
    ) ||
    /timed?\s*out|timeout|operation was aborted|\baborterror\b|\btimeouterror\b/i.test(
      lower,
    ) ||
    // Upstream 5xx / Cloudflare gateway timeouts (502–504, 520–524, …).
    // Already retried by apiRequest; not a code bug the remediator can fix.
    /\bhttp\s*5\d\d\b/i.test(lower)
  ) {
    // Do not cancel rate-limit noise just because a SmartDelivery test id
    // happens to contain the digits 404 (e.g. sender report 512404).
    if (
      !/required|must be|validation|\bhttp\s*404\b|\b404\b|not found/i.test(
        lower,
      )
    ) {
      return {
        class: "noise",
        fingerprint: fingerprintOf("noise", source),
        autoRemediate: false,
        summary: "Transient rate-limit / network noise",
        raw: text,
      };
    }
  }

  if (/surbl|uribl|unnamed domain-blacklist/i.test(lower)) {
    return {
      class: "noise",
      fingerprint: fingerprintOf("noise", "surbl"),
      autoRemediate: false,
      summary: "SURBL / URI-list noise (ignored for teardown)",
      raw: text,
    };
  }

  // Spend/destructive gates working as designed — human must approve or has
  // already denied. Not a code failure (D4/D15/D21).
  if (
    /awaiting approval|waiting on spend approval|see get \/approvals|spend approval needed|spend blocked by monthly cap/i.test(
      lower,
    )
  ) {
    return {
      class: "noise",
      fingerprint: fingerprintOf("noise", "approval-gate"),
      autoRemediate: false,
      summary: "Spend/destructive approval gate (human decision, not a bug)",
      raw: text,
    };
  }

  // Intentional holdOutcome retry path: a campaign removal failed, so we
  // deliberately left the mailbox unheld for the next run. The specific
  // `remove … from campaign …` error is the actionable row; this summary must
  // not launch a remediator (and used to fingerprint per-mailbox as unknown).
  if (
    /left unheld so the next run retries|campaign removal\(s\) failed/i.test(
      lower,
    )
  ) {
    return {
      class: "noise",
      fingerprint: fingerprintOf("noise", "retry-removal"),
      autoRemediate: false,
      summary:
        "Remediation deferred a hold after a campaign removal failed (next run retries)",
      raw: text,
    };
  }

  // D41 burn gate working as designed — blacklist alone must not purge a
  // domain. Not a code bug; do not launch a remediator (used to fingerprint
  // per-domain as unknown:remediation:…-burn-checklist).
  if (
    /burn checklist not ready|blacklist alone is not enough/i.test(lower)
  ) {
    return {
      class: "noise",
      fingerprint: fingerprintOf("noise", "burn-checklist"),
      autoRemediate: false,
      summary:
        "Burn checklist refused teardown (blacklist alone is not enough)",
      raw: text,
    };
  }

  if (
    /is required|must be of type|must be greater than|invalid parameters|validation/i.test(
      lower,
    ) ||
    /scheduler_cron_value|test_end_date|schedule_start_time|provider_ids/i.test(
      lower,
    )
  ) {
    const key = extractApiField(lower) || "validation";
    return {
      class: "api_validation",
      fingerprint: fingerprintOf("api_validation", key),
      autoRemediate: true,
      summary: `SmartDelivery/Smartlead API validation failure (${key})`,
      raw: text,
    };
  }

  // Deleted/expired SmartDelivery tests still linger in local state. "Spam
  // test not found" is a missing resource, not a wrong API path — do not
  // launch a remediator for it (fingerprint was collapsing to
  // stale-endpoint:endpoint and paging every monitor pass).
  if (
    /spam test not found|placement test not found|spam[_ -]?test.*\bnot found\b/i.test(
      lower,
    )
  ) {
    return {
      class: "noise",
      fingerprint: fingerprintOf("noise", "missing-test"),
      autoRemediate: false,
      summary: "SmartDelivery spam/placement test no longer exists",
      raw: text,
    };
  }

  if (
    /http 404|endpoint not found|cannot (get|post) \/api/i.test(lower) ||
    (/not found/i.test(lower) && /\/api\//i.test(lower))
  ) {
    const path = extractPath(lower) || "endpoint";
    return {
      class: "stale_endpoint",
      fingerprint: fingerprintOf("stale_endpoint", path),
      autoRemediate: true,
      summary: `Stale or wrong API endpoint (${path})`,
      raw: text,
    };
  }

  if (
    /is not a function|cannot read propert|undefined is not|typeerror/i.test(
      lower,
    )
  ) {
    return {
      class: "type_error",
      fingerprint: fingerprintOf("type_error", source),
      autoRemediate: true,
      summary: `Runtime TypeError in ${source}`,
      raw: text,
    };
  }

  // SmartDelivery billing/quota — a human must top up. Never launch a
  // remediator (it cannot and must not spend); do not treat as a code bug.
  if (
    /insufficient sequence credits|insufficient credits|out of (sequence )?credits|not enough (sequence )?credits/i.test(
      lower,
    )
  ) {
    return {
      class: "auth_access",
      fingerprint: fingerprintOf("auth_access", "sequence-credits"),
      autoRemediate: false,
      summary:
        "SmartDelivery sequence credits exhausted (human top-up required)",
      raw: text,
    };
  }

  // Seed inventory / PROVIDER_IDS config — SmartDelivery has no usable seeds
  // for the ids we sent. A remediator cannot provision seeds; Josh must fix
  // PROVIDER_IDS or wait for SmartDelivery capacity.
  if (
    /no seed accounts found|seed accounts found for the provided provider/i.test(
      lower,
    )
  ) {
    return {
      class: "auth_access",
      fingerprint: fingerprintOf("auth_access", "seed-providers"),
      autoRemediate: false,
      summary:
        "SmartDelivery has no seed accounts for the provided provider IDs (human/config)",
      raw: text,
    };
  }

  if (
    /smartdelivery access|api access is not active|invalid api key|unauthorized/i.test(
      lower,
    )
  ) {
    return {
      class: "auth_access",
      fingerprint: fingerprintOf("auth_access", "smartdelivery"),
      autoRemediate: false,
      summary: "SmartDelivery/Smartlead access/auth problem (human/config)",
      raw: text,
    };
  }

  if (/slice\(0,\s*40\)|report cap|test id priority|fan-?out/i.test(lower)) {
    return {
      class: "report_fanout",
      fingerprint: fingerprintOf("report_fanout", "cap"),
      autoRemediate: true,
      summary: "Placement report fan-out / test-id selection bug",
      raw: text,
    };
  }

  return {
    class: "unknown",
    fingerprint: fingerprintOf("unknown", source, stabilize(lower)),
    autoRemediate: true,
    summary: `Unrecognized failure in ${source}`,
    raw: text,
  };
}

function fingerprintOf(...parts: string[]): string {
  return parts
    .map((p) =>
      p
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48),
    )
    .filter(Boolean)
    .join(":");
}

function extractApiField(lower: string): string | undefined {
  const m = lower.match(
    /["']?(scheduler_cron_value|test_end_date|schedule_start_time|provider_ids|every_days|campaign_id|sequence_mapping_id)["']?/,
  );
  return m?.[1];
}

function extractPath(lower: string): string | undefined {
  const m = lower.match(/\/api\/v1\/[a-z0-9_\-\/{}.]+/i);
  return m?.[0]?.replace(/\/\d+/g, "/:id");
}

function stabilize(lower: string): string {
  return lower
    .replace(/\b\d{5,}\b/g, "N")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
      "UUID",
    )
    .replace(/\s+/g, " ")
    .slice(0, 80);
}
