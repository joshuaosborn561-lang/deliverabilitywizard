import { ApiError } from "../lib/http.js";

const BASE_URL = "https://api.inboxkit.com";

export interface InboxKitWorkspace {
  id?: string;
  uid?: string;
  name?: string;
}

export interface InboxKitDomain {
  uid?: string;
  id?: string;
  name?: string;
  domain?: string;
  status?: string;
  nameserver_match_status?: string;
  nameservers?: string[];
  platform?: string;
}

export interface InboxKitMailbox {
  uid?: string;
  id?: string;
  email?: string;
  address?: string;
  domain?: string;
  domain_name?: string;
  domain_uid?: string;
  status?: string;
  platform?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export class InboxKitClient {
  constructor(
    private readonly apiKey: string,
    private readonly workspaceId?: string,
    /**
     * Workspace that must never be purged (the generic recovery pool).
     * purgeDomain refuses to cancel anything inside it — those mailboxes are
     * shared infrastructure, not client sending domains.
     */
    private readonly protectedWorkspaceId?: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    workspaceId?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      // Cloudflare on api.inboxkit.com blocks empty/bot UAs from some hosts
      "User-Agent": "DeliverabilityWizard/1.0 (+railway)",
    };
    const ws = workspaceId || this.workspaceId;
    if (ws) headers["X-Workspace-Id"] = ws;

    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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
    if (!response.ok) {
      const message =
        typeof parsed === "object" &&
        parsed !== null &&
        ("message" in parsed || "error" in parsed)
          ? String(
              (parsed as { message?: unknown; error?: unknown }).message ??
                (parsed as { error?: unknown }).error,
            )
          : `HTTP ${response.status}`;
      throw new ApiError(message, response.status, parsed);
    }
    return parsed as T;
  }

  async listWorkspaces(): Promise<InboxKitWorkspace[]> {
    const raw = await this.request<unknown>("GET", "/v1/api/workspaces/list");
    return normalizeList<InboxKitWorkspace>(raw, [
      "workspaces",
      "result",
      "data",
      "items",
    ]);
  }

  async resolveWorkspaceId(): Promise<string> {
    if (this.workspaceId) return this.workspaceId;
    const workspaces = await this.listWorkspaces();
    const first = workspaces[0];
    const id = first?.uid || first?.id;
    if (!id) {
      throw new Error("InboxKit: no workspaces found for this API key");
    }
    return id;
  }

  async listDomains(
    workspaceId?: string,
    opts: { keyword?: string; limit?: number } = {},
  ): Promise<InboxKitDomain[]> {
    const ws = workspaceId || (await this.resolveWorkspaceId());
    const body: Record<string, unknown> = {
      page: 1,
      limit: opts.limit ?? 200,
    };
    if (opts.keyword) body.keyword = opts.keyword;
    const raw = await this.request<unknown>(
      "POST",
      "/v1/api/domains/list",
      body,
      ws,
    );
    return normalizeList<InboxKitDomain>(raw, [
      "domains",
      "result",
      "data",
      "items",
    ]);
  }

  /**
   * Connect external domains and receive Cloudflare nameservers to set at registrar.
   */
  async connectNameservers(
    domains: string[],
    workspaceId?: string,
  ): Promise<
    Array<{
      domain: string;
      nameservers?: string[];
      uid?: string;
      name?: string;
    }>
  > {
    const ws = workspaceId || (await this.resolveWorkspaceId());
    const raw = await this.request<unknown>(
      "POST",
      "/v1/api/domains/nameservers",
      {
        domains: domains.map((d) => d.toLowerCase()),
      },
      ws,
    );
    return normalizeList(raw, ["data", "domains", "result", "items"]);
  }

  /**
   * Buy Google/Microsoft mailboxes. One platform per domain (InboxKit cannot mix).
   */
  async buyMailboxes(
    mailboxes: Array<{
      first_name: string;
      last_name: string;
      username: string;
      platform: "GOOGLE" | "MICROSOFT";
      domain_name: string;
    }>,
    opts: {
      workspaceId?: string;
      useWalletBalance?: boolean;
      idempotencyKey?: string;
    } = {},
  ): Promise<unknown> {
    const ws = opts.workspaceId || (await this.resolveWorkspaceId());
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "DeliverabilityWizard/1.0 (+railway)",
      "X-Workspace-Id": ws,
    };
    if (opts.idempotencyKey) {
      headers["Idempotency-Key"] = opts.idempotencyKey;
    }
    const body = {
      mailboxes,
      ...(opts.useWalletBalance ? { use_wallet_balance: true } : {}),
    };
    const response = await fetch(`${BASE_URL}/v1/api/mailboxes/buy`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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
    if (!response.ok) {
      const message =
        typeof parsed === "object" &&
        parsed !== null &&
        ("message" in parsed || "error" in parsed)
          ? String(
              (parsed as { message?: unknown; error?: unknown }).message ??
                (parsed as { error?: unknown }).error,
            )
          : `HTTP ${response.status}`;
      throw new ApiError(message, response.status, parsed);
    }
    return parsed;
  }

  async listSequencers(
    workspaceId?: string,
  ): Promise<Array<{ uid?: string; id?: string; name?: string; platform?: string }>> {
    const ws = workspaceId || (await this.resolveWorkspaceId());
    const raw = await this.request<unknown>(
      "POST",
      "/v1/api/sequencers/list",
      {},
      ws,
    );
    return normalizeList(raw, ["data", "sequencers", "result", "items"]);
  }

  async addSequencer(
    fields: Record<string, unknown>,
    workspaceId?: string,
  ): Promise<string> {
    const ws = workspaceId || (await this.resolveWorkspaceId());
    const raw = await this.request<{ uid?: string; data?: { uid?: string } }>(
      "POST",
      "/v1/api/sequencers/add",
      fields,
      ws,
    );
    const uid = raw.uid || raw.data?.uid;
    if (!uid) {
      throw new ApiError("InboxKit add sequencer returned no uid", 500, raw);
    }
    return uid;
  }

  async exportMailboxesToSequencer(
    sequencerUid: string,
    mailboxUids: string[],
    workspaceId?: string,
  ): Promise<unknown> {
    const ws = workspaceId || (await this.resolveWorkspaceId());
    return this.request(
      "POST",
      "/v1/api/sequencers/export",
      { sequencer_uid: sequencerUid, mailbox_uids: mailboxUids },
      ws,
    );
  }

  async getExportStatus(
    workspaceId?: string,
    opts: { sequencerUid?: string; status?: string } = {},
  ): Promise<unknown> {
    const ws = workspaceId || (await this.resolveWorkspaceId());
    const body: Record<string, unknown> = {};
    if (opts.sequencerUid) body.sequencer_uid = opts.sequencerUid;
    if (opts.status) body.status = opts.status;
    return this.request(
      "POST",
      "/v1/api/sequencers/export/status",
      body,
      ws,
    );
  }

  /** True when InboxKit reports nameservers as matched/propagated. */
  static nameserversReady(domain: InboxKitDomain): boolean {
    const status = String(domain.nameserver_match_status ?? "").toLowerCase();
    const life = String(domain.status ?? "").toLowerCase();
    if (
      status.includes("match") ||
      status.includes("synced") ||
      status.includes("propagat") ||
      status === "ok" ||
      status === "ready"
    ) {
      return true;
    }
    if (life === "active" || life === "ready") return true;
    return false;
  }

  async listMailboxes(opts: {
    domain?: string;
    domainUid?: string;
    keyword?: string;
    workspaceId?: string;
    limit?: number;
  } = {}): Promise<InboxKitMailbox[]> {
    const ws = opts.workspaceId || (await this.resolveWorkspaceId());
    const body: Record<string, unknown> = {
      page: 1,
      limit: opts.limit ?? 200,
    };
    if (opts.domain) body.domain = opts.domain;
    if (opts.domainUid) body.domain_uid = opts.domainUid;
    if (opts.keyword) body.keyword = opts.keyword;
    const raw = await this.request<unknown>(
      "POST",
      "/v1/api/mailboxes/list",
      body,
      ws,
    );
    return normalizeList<InboxKitMailbox>(raw, [
      "mailboxes",
      "result",
      "data",
      "items",
    ]);
  }

  async removeDomains(
    domains: string[],
    workspaceId?: string,
  ): Promise<unknown> {
    const ws = workspaceId || (await this.resolveWorkspaceId());
    return this.request(
      "POST",
      "/v1/api/domains/remove",
      { domains: domains.map((d) => d.toLowerCase()) },
      ws,
    );
  }

  async cancelMailboxes(
    uids: string[],
    opts: { domainUids?: string[]; workspaceId?: string } = {},
  ): Promise<unknown> {
    const ws = opts.workspaceId || (await this.resolveWorkspaceId());
    const body: Record<string, unknown> = { uids };
    if (opts.domainUids?.length) body.domain_uids = opts.domainUids;
    return this.request("POST", "/v1/api/mailboxes/cancel", body, ws);
  }

  /**
   * Locate a domain across all workspaces (or a single configured workspace).
   */
  async findDomain(domain: string): Promise<{
    workspaceId: string;
    workspaceName?: string;
    domain: InboxKitDomain;
  } | null> {
    const target = domain.toLowerCase();
    const workspaces = this.workspaceId
      ? [{ uid: this.workspaceId, name: undefined }]
      : await this.listWorkspaces();

    for (const ws of workspaces) {
      const wsId = ws.uid || ws.id;
      if (!wsId) continue;
      const domains = await this.listDomains(wsId, {
        keyword: target,
        limit: 50,
      });
      const match = domains.find((d) => {
        const name = (d.name || d.domain || "").toLowerCase();
        return name === target;
      });
      if (match) {
        return { workspaceId: wsId, workspaceName: ws.name, domain: match };
      }
    }
    return null;
  }

  /**
   * Cancel all mailboxes for a domain, then schedule the domain for deletion.
   * Searches every InboxKit workspace unless INBOXKIT_WORKSPACE_ID is pinned.
   */
  async purgeDomain(domain: string): Promise<{
    domain: string;
    workspaceId: string;
    workspaceName?: string;
    cancelledMailboxUids: string[];
    removeResult: unknown;
  }> {
    const found = await this.findDomain(domain);
    if (!found) {
      throw new ApiError(
        `Domain ${domain} not found in InboxKit workspaces`,
        404,
        null,
      );
    }

    const ws = found.workspaceId;

    // Never tear down the generic recovery pool on a client-domain purge.
    if (this.protectedWorkspaceId && ws === this.protectedWorkspaceId) {
      throw new ApiError(
        `Refusing to purge ${domain}: it resolved to the protected generic-pool workspace (${ws}). Purge only runs against client sending domains.`,
        409,
        null,
      );
    }

    const target = domain.toLowerCase();
    const mailboxes = await this.listMailboxes({
      domain: target,
      keyword: target,
      workspaceId: ws,
    });

    // `keyword` is a fuzzy server-side filter — confirm each mailbox really
    // belongs to this domain before cancelling it, so a loose match can never
    // cancel unrelated paid mailboxes.
    const uids = mailboxes
      .filter((m) => mailboxDomainOf(m) === target)
      .map((m) => m.uid || m.id)
      .filter((x): x is string => Boolean(x));

    const skipped = mailboxes.length - uids.length;
    if (skipped > 0) {
      console.warn(
        `[inboxkit] purgeDomain ${domain}: ignoring ${skipped} mailbox(es) that did not match the domain exactly`,
      );
    }

    if (uids.length) {
      await this.cancelMailboxes(uids, { workspaceId: ws });
    }

    const domainUid = found.domain.uid || found.domain.id;
    const removeResult = await this.request(
      "POST",
      "/v1/api/domains/remove",
      {
        domains: [domain.toLowerCase()],
        ...(domainUid ? { uids: [String(domainUid)] } : {}),
      },
      ws,
    );

    return {
      domain,
      workspaceId: ws,
      workspaceName: found.workspaceName,
      cancelledMailboxUids: uids,
      removeResult,
    };
  }
}

/** Sending domain for a mailbox row, however InboxKit spelled it. */
export function mailboxDomainOf(mailbox: InboxKitMailbox): string {
  const email = (mailbox.email || mailbox.address || "").toLowerCase();
  return (
    (mailbox.domain_name || mailbox.domain || "").toLowerCase() ||
    (email.includes("@") ? email.split("@")[1]! : "")
  );
}

function normalizeList<T>(
  raw: unknown,
  preferredKeys: string[] = [
    "result",
    "data",
    "items",
    "domains",
    "mailboxes",
    "workspaces",
  ],
): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of preferredKeys) {
      const value = obj[key];
      if (Array.isArray(value)) return value as T[];
      if (value && typeof value === "object") {
        const nested = value as Record<string, unknown>;
        for (const k2 of ["items", "data", "results", "rows", "workspaces"]) {
          if (Array.isArray(nested[k2])) return nested[k2] as T[];
        }
      }
    }
  }
  return [];
}
