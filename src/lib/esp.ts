/** Sender / seed ESP families used for same-ESP deliverability scoring. */
export type EspFamily = "google" | "microsoft" | "other";
export type SeedEsp = "google" | "microsoft" | "unknown";

export type SenderEspAccount = {
  type?: string | null;
  platform?: string | null;
  smtp_host?: string | null;
  smtpHost?: string | null;
  tags?: Array<{ tag_name?: string; name?: string } | string> | null;
};

export type SenderEspInput = string | null | undefined | SenderEspAccount;

function tagNamesOf(input: SenderEspInput): string[] {
  if (!input || typeof input === "string") return [];
  return (input.tags ?? [])
    .map((tag) =>
      typeof tag === "string"
        ? tag
        : String(tag.tag_name ?? tag.name ?? ""),
    )
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

function typeStringOf(input: SenderEspInput): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  return String(input.type ?? input.platform ?? "");
}

function smtpHostOf(input: SenderEspInput): string {
  if (!input || typeof input === "string") return "";
  return String(input.smtp_host ?? input.smtpHost ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Map a Smartlead account to a scoring family.
 * D301 — SMTP on smtp.gmail.com and type:google are Gmail;
 * type:m365 / type:azure are Microsoft. A bare type string still works.
 */
export function normalizeSenderEspFamily(
  typeOrAccount: SenderEspInput,
): EspFamily {
  const tags = tagNamesOf(typeOrAccount);
  if (tags.includes("type:google")) return "google";
  if (tags.includes("type:m365") || tags.includes("type:azure")) {
    return "microsoft";
  }
  if (smtpHostOf(typeOrAccount) === "smtp.gmail.com") return "google";

  const t = typeStringOf(typeOrAccount).trim().toUpperCase();
  if (
    t === "GMAIL" ||
    t === "GOOGLE" ||
    t === "GSUITE" ||
    t === "G_SUITE" ||
    t === "GOOGLE_OAUTH"
  ) {
    return "google";
  }
  if (
    t === "OUTLOOK" ||
    t === "MICROSOFT" ||
    t === "OFFICE365" ||
    t === "O365" ||
    t === "AZURE" ||
    t === "MICROSOFT_OAUTH"
  ) {
    return "microsoft";
  }
  return "other";
}

/**
 * Classify a SmartDelivery seed placement as Google (G Suite) or Microsoft (O365).
 * Uses receiving-MTA signals in SPF/DKIM/DMARC auth results.
 */
export function classifySeedEsp(detail: unknown): SeedEsp {
  if (!detail || typeof detail !== "object") return "unknown";
  const row = detail as Record<string, unknown>;
  const reply =
    row.reply && typeof row.reply === "object"
      ? (row.reply as Record<string, unknown>)
      : undefined;

  const spf = textFromAuth(reply?.spf_result ?? row.spf_result);
  const dkim = textFromAuth(reply?.dkim_result ?? row.dkim_result);
  const dmarc = textFromAuth(reply?.dmarc_result ?? row.dmarc_result);
  const blob = `${spf}\n${dkim}\n${dmarc}`.toLowerCase();

  // Outlook/O365 seeds authenticate via protection.outlook.com
  if (blob.includes("protection.outlook.com")) return "microsoft";

  // Gmail / Google Workspace seeds authenticate via mx.google.com
  if (
    blob.includes("mx.google.com") ||
    blob.includes("google.com:") ||
    /\bgoogle\.com\b/.test(blob)
  ) {
    return "google";
  }

  const rdns = String(
    (reply?.rdns_result as { rdns?: string } | undefined)?.rdns ??
      (row.rdns_result as { rdns?: string } | undefined)?.rdns ??
      "",
  ).toLowerCase();
  if (rdns.includes("1e100.net")) return "google";

  return "unknown";
}

function textFromAuth(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return String(obj.spf ?? obj.dkim ?? obj.dmarc ?? obj.status ?? "");
  }
  return "";
}

export function mailFolderOf(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const row = detail as Record<string, unknown>;
  const reply =
    row.reply && typeof row.reply === "object"
      ? (row.reply as Record<string, unknown>)
      : undefined;
  return String(reply?.mail_folder ?? row.mail_folder ?? row.folder ?? "").trim();
}
