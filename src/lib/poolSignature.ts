import { Resolver } from "node:dns/promises";

/**
 * Dynamic signature for recovery-pool generics while covering a client:
 *   First Last
 *   {Client Brand}
 */
export function buildPoolSignature(opts: {
  firstName: string;
  lastName: string;
  clientBrand: string;
}): string {
  const first = opts.firstName.trim();
  const last = opts.lastName.trim();
  const brand = opts.clientBrand.trim();
  if (!first || !last) {
    throw new Error("firstName and lastName are required for pool signature");
  }
  if (!brand) {
    throw new Error("clientBrand is required for pool signature");
  }
  return `${first} ${last}\n${brand}`;
}

export function parsePersonName(fromName?: string | null): {
  firstName: string;
  lastName: string;
} {
  const parts = (fromName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Alex", lastName: "Morgan" };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "Team" };
  return {
    firstName: parts[0]!,
    lastName: parts.slice(1).join(" "),
  };
}

/** Map Smartlead account type → pool ESP bucket. */
export function poolEspFromSmartleadType(
  type?: string | null,
): "GOOGLE" | "MICROSOFT" | null {
  const t = (type ?? "").toUpperCase();
  if (!t) return null;
  if (t.includes("GMAIL") || t.includes("GOOGLE")) return "GOOGLE";
  if (t.includes("OUTLOOK") || t.includes("MICROSOFT") || t.includes("O365")) {
    return "MICROSOFT";
  }
  return null;
}

/**
 * Infer pool ESP from public MX / SPF when Smartlead reports a generic type
 * like `SMTP` (custom SMTP/IMAP credentials on Google Workspace or M365).
 *
 * Microsoft is checked first so a dual-stack zone cannot flip a protection.outlook
 * sender into the Google bucket.
 */
export function poolEspFromDnsRecords(opts: {
  mx?: readonly string[] | null;
  txt?: readonly string[] | null;
}): "GOOGLE" | "MICROSOFT" | null {
  const mx = (opts.mx ?? []).map((r) => r.toLowerCase());
  const txt = (opts.txt ?? []).map((r) => r.toLowerCase());
  const mxBlob = mx.join("\n");
  const txtBlob = txt.join("\n");

  if (
    mx.some(
      (r) =>
        r.includes("mail.protection.outlook.com") ||
        r.endsWith(".protection.outlook.com"),
    ) ||
    /include:\s*spf\.protection\.outlook\.com/i.test(txtBlob)
  ) {
    return "MICROSOFT";
  }

  if (
    mx.some(
      (r) =>
        r === "smtp.google.com" ||
        r.endsWith(".smtp.google.com") ||
        r.includes("aspmx.l.google.com") ||
        r.includes("aspmx2.googlemail.com") ||
        r.includes("aspmx3.googlemail.com") ||
        r.includes("googlemail.com") ||
        /(^|\.)(aspmx|alt\d\.aspmx)\.l\.google\.com$/.test(r),
    ) ||
    /include:\s*_spf\.google\.com/i.test(txtBlob)
  ) {
    return "GOOGLE";
  }

  // Consumer mailbox domains (rare as Smartlead SMTP custom-hosts).
  if (mxBlob.includes("outlook.com") || mxBlob.includes("hotmail.com")) {
    return "MICROSOFT";
  }
  if (mxBlob.includes("gmail-smtp-in.l.google.com")) {
    return "GOOGLE";
  }

  return null;
}

export type PoolEspDnsLookup = (domain: string) => Promise<{
  mx: string[] | null;
  txt: string[] | null;
}>;

async function defaultPoolEspDnsLookup(
  domain: string,
): Promise<{ mx: string[] | null; txt: string[] | null }> {
  const resolver = new Resolver();
  resolver.setServers(["8.8.8.8", "1.1.1.1"]);
  const [mx, txt] = await Promise.all([
    resolver
      .resolveMx(domain)
      .then((rows) => rows.map((r) => r.exchange))
      .catch(() => null),
    resolver
      .resolveTxt(domain)
      .then((rows) => rows.map((parts) => parts.join("")))
      .catch(() => null),
  ]);
  return { mx, txt };
}

/**
 * Resolve GOOGLE/MICROSOFT for a sending domain via public DNS.
 * Used when Smartlead's account `type` is SMTP / unrecognized.
 */
export async function resolvePoolEspFromDomain(
  domain: string,
  lookup: PoolEspDnsLookup = defaultPoolEspDnsLookup,
): Promise<"GOOGLE" | "MICROSOFT" | null> {
  const host = domain.trim().toLowerCase();
  if (!host || host.includes("@") || host.includes(" ")) return null;
  const records = await lookup(host);
  return poolEspFromDnsRecords(records);
}
