export type AuthVerdict = "pass" | "fail" | "unknown";

export interface SenderAuthSummary {
  email: string;
  spfPass: number;
  spfFail: number;
  dkimPass: number;
  dkimFail: number;
  dmarcPass: number;
  dmarcFail: number;
  /** Seed rows that carried any auth verdict. */
  samples: number;
}

/** True when SPF failed on every scored seed for this sender. */
export function spfFailing(row: SenderAuthSummary): boolean {
  return row.spfFail > 0 && row.spfPass === 0;
}

export function dkimFailing(row: SenderAuthSummary): boolean {
  return row.dkimFail > 0 && row.dkimPass === 0;
}

/**
 * SmartDelivery reports auth as either a bare verdict ("pass") or a raw
 * Authentication-Results blob ("spf=fail (google.com: domain of …)").
 */
export function authVerdictOf(value: unknown, kind: "spf" | "dkim" | "dmarc"): AuthVerdict {
  const text = flattenAuth(value, kind).toLowerCase();
  if (!text) return "unknown";

  // Prefer an explicit "spf=pass" / "dkim=fail" token when present
  const tagged = new RegExp(`\\b${kind}\\s*=\\s*(\\w+)`).exec(text);
  if (tagged) return normalizeVerdict(tagged[1]!);

  if (/\b(pass|passed|ok|valid|success)\b/.test(text)) return "pass";
  if (/\b(fail|failed|softfail|permerror|temperror|none|invalid|missing)\b/.test(text)) {
    return "fail";
  }
  return "unknown";
}

function normalizeVerdict(token: string): AuthVerdict {
  const t = token.toLowerCase();
  if (["pass", "passed", "ok", "valid", "success"].includes(t)) return "pass";
  if (
    ["fail", "failed", "softfail", "permerror", "temperror", "none", "invalid", "missing"].includes(
      t,
    )
  ) {
    return "fail";
  }
  return "unknown";
}

function flattenAuth(value: unknown, kind: "spf" | "dkim" | "dmarc"): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "pass" : "fail";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const nested = obj[kind] ?? obj.status ?? obj.result ?? obj.value;
    if (nested !== undefined && nested !== null) return flattenAuth(nested, kind);
  }
  return "";
}

/**
 * Per-sender SPF/DKIM/DMARC tallies from the sender-account-wise report.
 * Mirrors the SPF/DKIM columns SmartDelivery shows per seed row.
 */
export function parseSenderAuthResults(raw: unknown): SenderAuthSummary[] {
  const rows = asRows(raw);
  const out: SenderAuthSummary[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const email = String(
      obj.email || obj.from_email || obj.sender_email || "",
    ).trim();
    if (!email) continue;

    const summary: SenderAuthSummary = {
      email,
      spfPass: 0,
      spfFail: 0,
      dkimPass: 0,
      dkimFail: 0,
      dmarcPass: 0,
      dmarcFail: 0,
      samples: 0,
    };

    const details = Array.isArray(obj.details) ? obj.details : [obj];
    for (const item of details) {
      if (!item || typeof item !== "object") continue;
      const detail = item as Record<string, unknown>;
      const reply =
        detail.reply && typeof detail.reply === "object"
          ? (detail.reply as Record<string, unknown>)
          : undefined;

      const spf = authVerdictOf(reply?.spf_result ?? detail.spf_result ?? detail.spf, "spf");
      const dkim = authVerdictOf(
        reply?.dkim_result ?? detail.dkim_result ?? detail.dkim,
        "dkim",
      );
      const dmarc = authVerdictOf(
        reply?.dmarc_result ?? detail.dmarc_result ?? detail.dmarc,
        "dmarc",
      );

      if (spf === "unknown" && dkim === "unknown" && dmarc === "unknown") continue;
      summary.samples += 1;
      if (spf === "pass") summary.spfPass += 1;
      if (spf === "fail") summary.spfFail += 1;
      if (dkim === "pass") summary.dkimPass += 1;
      if (dkim === "fail") summary.dkimFail += 1;
      if (dmarc === "pass") summary.dmarcPass += 1;
      if (dmarc === "fail") summary.dmarcFail += 1;
    }

    if (summary.samples > 0) out.push(summary);
  }

  return out;
}

function asRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["result", "data", "items", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}
