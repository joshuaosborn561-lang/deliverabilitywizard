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
    )
  ) {
    if (!/required|must be|validation|404|not found/i.test(lower)) {
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

  if (
    /http 404|not found|endpoint not found|cannot (get|post) \/api/i.test(lower)
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
