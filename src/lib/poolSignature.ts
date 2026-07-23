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
