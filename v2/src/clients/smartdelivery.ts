import { getJson, postJson, type ScheduleFn } from "./http.js";
import type { SpamTest } from "../types.js";

/** Same base the old wizard uses (`src/clients/smartdelivery.ts`). */
export const SMARTDELIVERY_BASE = "https://smartdelivery.smartlead.ai/api/v1/";
export const LIST_TESTS_PATH = "spam-test/report";
export const DEFAULT_TEST_LIST_LIMIT = 100;
export const SENDER_HYDRATE_CAP = 80;

export class SmartDeliveryReader {
  constructor(
    private readonly apiKey: string,
    private readonly schedule: ScheduleFn = (fn) => fn(),
  ) {}

  private url(path: string): string {
    const u = new URL(path.replace(/^\//, ""), SMARTDELIVERY_BASE);
    u.searchParams.set("api_key", this.apiKey);
    return u.toString();
  }

  /**
   * Failed list is an ERROR. Never `.catch(() => [])`.
   * POST /api/v1/spam-test/report (SmartDelivery list). The unversioned
   * collection path 404s.
   */
  async listTests(): Promise<SpamTest[]> {
    const all: SpamTest[] = [];
    const limit = DEFAULT_TEST_LIST_LIMIT;
    for (let offset = 0, page = 0; page < 50; page += 1, offset += limit) {
      const raw = await this.schedule(() =>
        postJson<unknown>(this.url(LIST_TESTS_PATH), { limit, offset }),
      );
      const rows = normalizeList(raw);
      all.push(...rows.map(normalizeTest));
      if (rows.length < limit) break;
    }
    return all;
  }

  async getSenderAccountWise(testId: string): Promise<unknown> {
    return this.schedule(() =>
      getJson<unknown>(this.url(`spam-test/report/${encodeURIComponent(testId)}/sender-account-wise`)),
    );
  }

  /**
   * Report list omits per-seed inbox rows. Hydrate sender-account-wise
   * for tests that still have no senders (cap so we cannot 429 the board).
   */
  async hydrateSenders(tests: SpamTest[], cap = SENDER_HYDRATE_CAP): Promise<SpamTest[]> {
    const out: SpamTest[] = [];
    let used = 0;
    for (const test of tests) {
      if ((test.senders?.length ?? 0) > 0 || !test.id || used >= cap) {
        out.push(test);
        continue;
      }
      used += 1;
      try {
        const raw = await this.getSenderAccountWise(test.id);
        const senders = sendersFromAccountWise(raw);
        out.push(senders.length ? { ...test, senders } : test);
      } catch {
        out.push(test);
      }
    }
    return out;
  }
}

function normalizeList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["data", "result", "results", "tests", "items"]) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
    }
  }
  throw new Error("SmartDelivery listTests returned no array");
}

function normalizeTest(row: Record<string, unknown>): SpamTest {
  const id = row.spam_test_id ?? row.id;
  const sendersRaw = (row.senders ?? row.sender_list ?? row.accounts ?? []) as unknown[];
  const senders = Array.isArray(sendersRaw)
    ? sendersRaw.flatMap((s) => senderFromUnknown(s)).filter((s) => s.email)
    : [];
  return {
    id: String(id ?? ""),
    name: String(row.test_name ?? row.name ?? ""),
    campaignId: row.campaign_id == null ? undefined : String(row.campaign_id),
    status: row.status == null ? undefined : String(row.status),
    senders,
  };
}

export function sendersFromAccountWise(raw: unknown): NonNullable<SpamTest["senders"]> {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as Record<string, unknown>).result as unknown[]) ||
        ((raw as Record<string, unknown>).data as unknown[]) ||
        ((raw as Record<string, unknown>).items as unknown[]) ||
        []
      : [];
  const out: NonNullable<SpamTest["senders"]> = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const email = String(obj.email ?? obj.from_email ?? obj.sender_email ?? "").toLowerCase();
    if (!email) continue;
    const details = Array.isArray(obj.details) ? obj.details : null;
    if (details?.length) {
      for (const seed of details) {
        const parsed = senderFromUnknown(seed, email);
        if (parsed.email) out.push(parsed);
      }
      continue;
    }
    out.push(senderFromUnknown(obj, email));
  }
  return out;
}

function senderFromUnknown(
  value: unknown,
  fallbackEmail = "",
): { email: string; inbox?: boolean; provider?: string } {
  if (!value || typeof value !== "object") {
    return { email: fallbackEmail };
  }
  const o = value as Record<string, unknown>;
  const email = String(o.email ?? o.from_email ?? o.sender_email ?? fallbackEmail).toLowerCase();
  const folder = String(
    (o.reply && typeof o.reply === "object"
      ? (o.reply as Record<string, unknown>).mail_folder
      : undefined) ??
      o.mail_folder ??
      o.folder ??
      "",
  ).toLowerCase();
  const inbox =
    folder === "inbox"
      ? true
      : folder === "spam" || folder === "promotions" || folder === "tab"
        ? false
        : Boolean(o.inbox ?? o.landed_inbox ?? o.is_inbox);
  const provider = String(o.provider ?? o.esp ?? o.seed_provider ?? o.provider_name ?? "unknown");
  return { email, inbox, provider };
}
