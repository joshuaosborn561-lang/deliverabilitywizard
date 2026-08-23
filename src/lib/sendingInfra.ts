/**
 * D53 — what our mailboxes actually send from, read from SmartDelivery
 * placement reports we already pull (IP analytics, rDNS, IP blacklist).
 */

export interface SendingIpRow {
  ip: string;
  domain?: string;
  fromEmail?: string;
  country?: string;
  regionOk: boolean | null;
  owner?: string;
  rdns?: string;
  listed: boolean;
  listNames: string[];
  reputableEsp: boolean;
}

export type InfraVerdict = "good" | "mixed" | "bad" | "unknown";

export interface InfraSummary {
  verdict: InfraVerdict;
  headline: string;
  rows: SendingIpRow[];
  domains: number;
  listed: number;
  offRegion: number;
  reputable: number;
}

const RIGHT_REGION = /\b(united states|usa|u\.s\.a?|us|canada|ca|north america)\b/i;
const WRONG_REGION =
  /\b(india|singapore|russia|china|vietnam|philippines|ukraine|nigeria|pakistan|bangladesh|indonesia)\b/i;
const REPUTABLE =
  /\b(google|gmail|1e100|microsoft|outlook|office365|protection\.outlook|yahoo|amazon|proofpoint)\b/i;

export function parseSendingInfra(input: {
  analytics?: unknown;
  rdns?: unknown;
  blacklist?: unknown;
}): SendingIpRow[] {
  const byIp = new Map<string, SendingIpRow>();

  for (const obj of walkObjects(input.analytics)) {
    const ip = pickIp(obj);
    if (!ip) continue;
    const row = take(byIp, ip);
    row.domain = row.domain ?? pickDomain(obj);
    row.fromEmail = row.fromEmail ?? pickEmail(obj);
    row.country = row.country ?? pickCountry(obj);
    row.owner = row.owner ?? pickOwner(obj);
    row.rdns = row.rdns ?? pickRdns(obj);
  }

  for (const obj of walkObjects(input.rdns)) {
    const ip = pickIp(obj);
    if (!ip) continue;
    const row = take(byIp, ip);
    row.rdns = row.rdns ?? pickRdns(obj);
    row.domain = row.domain ?? pickDomain(obj);
    row.fromEmail = row.fromEmail ?? pickEmail(obj);
    row.owner = row.owner ?? pickOwner(obj);
    row.country = row.country ?? pickCountry(obj);
  }

  for (const obj of walkObjects(input.blacklist)) {
    const ip = pickIp(obj);
    if (!ip) continue;
    const listed = isListed(obj);
    if (!listed) continue;
    const row = take(byIp, ip);
    row.listed = true;
    const name = str(obj.blacklist_type_value ?? obj.list ?? obj.name);
    if (name && !row.listNames.includes(name)) row.listNames.push(name);
    row.domain = row.domain ?? pickDomain(obj);
    row.fromEmail = row.fromEmail ?? pickEmail(obj);
  }

  return [...byIp.values()].map(finalizeRow);
}

export function summarizeSendingInfra(rows: SendingIpRow[]): InfraSummary {
  if (!rows.length) {
    return {
      verdict: "unknown",
      headline:
        "I could not read sending IPs from the placement reports. Nothing to decide on the add-on yet.",
      rows,
      domains: 0,
      listed: 0,
      offRegion: 0,
      reputable: 0,
    };
  }

  const listed = rows.filter((row) => row.listed).length;
  const offRegion = rows.filter((row) => row.regionOk === false).length;
  const reputable = rows.filter((row) => row.reputableEsp).length;
  const domains = new Set(
    rows.map((row) => row.domain).filter((domain): domain is string => Boolean(domain)),
  ).size;

  let verdict: InfraVerdict;
  if (listed > 0 || offRegion > rows.length / 2) verdict = "bad";
  else if (offRegion > 0 || listed > 0) verdict = "mixed";
  else if (reputable >= rows.length / 2 || (offRegion === 0 && listed === 0)) {
    verdict = "good";
  } else verdict = "mixed";

  return {
    verdict,
    headline: headlineFor(verdict, { listed, offRegion, reputable, total: rows.length }),
    rows,
    domains,
    listed,
    offRegion,
    reputable,
  };
}

export function formatInfraMessage(summary: InfraSummary): string {
  const lines = [summary.headline];
  if (summary.rows.length) {
    lines.push(
      `I read ${summary.rows.length} sending IP${summary.rows.length === 1 ? "" : "s"} across ${summary.domains || "our"} sending domain${summary.domains === 1 ? "" : "s"} from the placement reports we already run.`,
    );
  }
  if (summary.verdict === "good") {
    lines.push(
      "The add-on that claims a reply lift by moving inboxes onto better IPs would buy us nothing. Drop it.",
    );
  } else if (summary.verdict === "bad") {
    lines.push(
      "This is bigger than an add-on. Mail is leaving from the wrong place or a listed range. I want you to see this now.",
    );
  } else if (summary.verdict === "mixed") {
    lines.push(
      "Some mail looks fine and some does not. Do not buy an add-on until we know which domains are the problem.",
    );
  }
  const samples = summary.rows.slice(0, 8).map(describeRow);
  if (samples.length) {
    lines.push("Examples:");
    lines.push(...samples.map((line) => `• ${line}`));
  }
  return lines.join("\n");
}

function headlineFor(
  verdict: InfraVerdict,
  counts: { listed: number; offRegion: number; reputable: number; total: number },
): string {
  if (verdict === "good") {
    return "Our mailboxes are sending from reputable ranges in the right region.";
  }
  if (verdict === "bad") {
    if (counts.listed) {
      return "Sending IPs are showing up on blacklists. That is not a marketing claim — it is in our placement reports.";
    }
    return "Mail is leaving from IP ranges that are not in the region we sell into.";
  }
  if (verdict === "mixed") {
    return "Sending infrastructure is mixed — some good ranges, some not.";
  }
  return "I do not have a clean reading of our sending IPs yet.";
}

function describeRow(row: SendingIpRow): string {
  const where = row.country || "unknown place";
  const who = row.owner || row.rdns || "unknown owner";
  const list = row.listed
    ? ` listed (${row.listNames.join(", ") || "blacklist"})`
    : " not listed";
  const domain = row.domain ? `${row.domain} ` : "";
  return `${domain}${row.ip} — ${where}, ${who}${list}`;
}

function finalizeRow(row: SendingIpRow): SendingIpRow {
  const hay = [row.country, row.owner, row.rdns, row.domain]
    .filter(Boolean)
    .join(" ");
  row.reputableEsp = REPUTABLE.test(hay);
  if (row.country) {
    if (RIGHT_REGION.test(row.country) || row.reputableEsp) row.regionOk = true;
    else if (WRONG_REGION.test(row.country)) row.regionOk = false;
    else row.regionOk = RIGHT_REGION.test(hay) ? true : null;
  } else if (row.reputableEsp) {
    row.regionOk = true;
  }
  return row;
}

function take(map: Map<string, SendingIpRow>, ip: string): SendingIpRow {
  const existing = map.get(ip);
  if (existing) return existing;
  const created: SendingIpRow = {
    ip,
    regionOk: null,
    listed: false,
    listNames: [],
    reputableEsp: false,
  };
  map.set(ip, created);
  return created;
}

function walkObjects(raw: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    out.push(obj);
    for (const nested of Object.values(obj)) {
      if (nested && typeof nested === "object") visit(nested, depth + 1);
    }
  };
  visit(raw, 0);
  return out;
}

function pickIp(obj: Record<string, unknown>): string | undefined {
  const raw = str(obj.ip ?? obj.ip_address ?? obj.sending_ip ?? obj.source_ip);
  if (!raw) return undefined;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(raw) && !raw.includes(":")) return undefined;
  return raw;
}

function pickEmail(obj: Record<string, unknown>): string | undefined {
  const nested =
    obj.reply && typeof obj.reply === "object"
      ? (obj.reply as Record<string, unknown>).from_email
      : undefined;
  return str(obj.from_email ?? obj.email ?? nested ?? obj["reply.from_email"]);
}

function pickDomain(obj: Record<string, unknown>): string | undefined {
  const email = pickEmail(obj);
  const fromEmail = email?.split("@")[1];
  return (fromEmail || str(obj.domain))?.toLowerCase();
}

function pickCountry(obj: Record<string, unknown>): string | undefined {
  return str(
    obj.country ??
      obj.country_name ??
      obj.geo_country ??
      obj.location ??
      (obj.geo && typeof obj.geo === "object"
        ? (obj.geo as Record<string, unknown>).country
        : undefined),
  );
}

function pickOwner(obj: Record<string, unknown>): string | undefined {
  return str(obj.org ?? obj.isp ?? obj.asn_org ?? obj.as_name ?? obj.owner ?? obj.asn);
}

function pickRdns(obj: Record<string, unknown>): string | undefined {
  const nested =
    obj.rdns_result && typeof obj.rdns_result === "object"
      ? (obj.rdns_result as Record<string, unknown>).rdns
      : undefined;
  return str(obj.rdns ?? nested ?? obj.ptr ?? obj.hostname);
}

function isListed(obj: Record<string, unknown>): boolean {
  const total = num(obj.total_blacklist);
  if (total != null && total > 0) return true;
  const details = str(obj.details)?.toLowerCase() ?? "";
  return details.includes("listed") && !details.includes("not listed");
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}
