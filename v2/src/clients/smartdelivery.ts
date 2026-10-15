import { getJson, type ScheduleFn } from "./http.js";
import type { SpamTest } from "../types.js";

const BASE = "https://smartdelivery.smartlead.ai/api";

export class SmartDeliveryReader {
  constructor(
    private readonly apiKey: string,
    private readonly schedule: ScheduleFn = (fn) => fn(),
  ) {}

  /**
   * Failed list is an ERROR. Never `.catch(() => [])`.
   */
  async listTests(): Promise<SpamTest[]> {
    const url = `${BASE}/spam-tests?api_key=${encodeURIComponent(this.apiKey)}`;
    const raw = await this.schedule(() => getJson<unknown>(url));
    const rows = normalizeList(raw);
    return rows.map(normalizeTest);
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
    ? sendersRaw.map((s) => {
        const o = s as Record<string, unknown>;
        return {
          email: String(o.email ?? o.from_email ?? "").toLowerCase(),
          inbox: Boolean(o.inbox ?? o.landed_inbox ?? o.is_inbox),
          provider: String(o.provider ?? o.esp ?? o.seed_provider ?? "unknown"),
        };
      })
    : [];
  return {
    id: String(id ?? ""),
    name: String(row.test_name ?? row.name ?? ""),
    campaignId: row.campaign_id == null ? undefined : String(row.campaign_id),
    status: row.status == null ? undefined : String(row.status),
    senders,
  };
}
