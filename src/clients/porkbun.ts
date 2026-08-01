import { ApiError, sleep } from "../lib/http.js";

const BASE_URL = "https://api.porkbun.com/api/json/v3";

export interface PorkbunCredentials {
  apiKey: string;
  secretApiKey: string;
}

export class PorkbunClient {
  constructor(private readonly creds: PorkbunCredentials) {}

  private async request<T>(
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "DeliverabilityWizard/1.0 (+railway)",
      },
      body: JSON.stringify({
        apikey: this.creds.apiKey,
        secretapikey: this.creds.secretApiKey,
        ...body,
      }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const status =
      typeof parsed === "object" &&
      parsed !== null &&
      "status" in parsed
        ? String((parsed as { status?: unknown }).status)
        : "";
    if (!response.ok || (status && status.toUpperCase() !== "SUCCESS")) {
      const message =
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed
          ? String((parsed as { message?: unknown }).message)
          : `Porkbun HTTP ${response.status}`;
      throw new ApiError(message, response.status, parsed);
    }
    return parsed as T;
  }

  getBalance(): Promise<{ balance?: string | number; status: string }> {
    // Endpoint varies by account age; ping is the reliable auth check.
    return this.request("/ping");
  }

  listDomains(): Promise<{
    status: string;
    count?: number;
    domains?: Array<{ domain: string; status?: string; tld?: string }>;
  }> {
    return this.request("/domain/listAll", { start: 0 });
  }

  /**
   * Availability check — Porkbun rate-limits to ~1 check / 10s.
   * Response shape: { status, response: { avail, price, ... } }
   */
  async checkDomain(domain: string): Promise<{
    available: boolean;
    price?: string;
    raw: unknown;
  }> {
    const raw = await this.request<Record<string, unknown>>(
      `/domain/checkDomain/${domain.toLowerCase()}`,
    );
    const nested =
      typeof raw.response === "object" && raw.response !== null
        ? (raw.response as Record<string, unknown>)
        : raw;
    const avail = String(nested.avail ?? nested.available ?? "").toLowerCase();
    const available = avail === "yes" || avail === "true" || avail === "1";
    const price =
      typeof nested.price === "string"
        ? nested.price
        : typeof nested.price === "number"
          ? String(nested.price)
          : undefined;
    return { available, price, raw };
  }

  /**
   * Register a domain. `costCents` must match checkDomain price in pennies
   * (e.g. $3.60 → 360). Requires agreeToTerms.
   */
  async createDomain(
    domain: string,
    opts: { years?: number; costCents: number },
  ): Promise<unknown> {
    return this.request(`/domain/create/${domain.toLowerCase()}`, {
      years: opts.years ?? 1,
      cost: opts.costCents,
      agreeToTerms: "yes",
    });
  }

  /** Convert checkDomain dollar price string (e.g. "3.60") to pennies. */
  static priceToCents(price: string | number | undefined): number | null {
    if (price === undefined || price === null || price === "") return null;
    const n = typeof price === "number" ? price : Number(price);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  }

  async updateAutoRenew(
    domain: string,
    status: "on" | "off",
  ): Promise<unknown> {
    return this.request(`/domain/updateAutoRenew/${domain.toLowerCase()}`, {
      status,
    });
  }

  async updateNameservers(
    domain: string,
    nameservers: string[],
  ): Promise<unknown> {
    return this.request(`/domain/updateNs/${domain.toLowerCase()}`, {
      ns: nameservers,
    });
  }

  /** Respect Porkbun's 1 availability check / 10 seconds limit. */
  async checkDomainThrottled(
    domain: string,
    minGapMs = 10_500,
  ): Promise<{ available: boolean; price?: string; raw: unknown }> {
    const result = await this.checkDomain(domain);
    await sleep(minGapMs);
    return result;
  }
}
