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
}

export interface InboxKitMailbox {
  uid?: string;
  id?: string;
  email?: string;
  address?: string;
  domain?: string;
  domain_uid?: string;
  status?: string;
}

export class InboxKitClient {
  constructor(
    private readonly apiKey: string,
    private readonly workspaceId?: string,
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

  async listMailboxes(opts: {
    domain?: string;
    domainUid?: string;
    keyword?: string;
    workspaceId?: string;
  } = {}): Promise<InboxKitMailbox[]> {
    const ws = opts.workspaceId || (await this.resolveWorkspaceId());
    const body: Record<string, unknown> = { page: 1, limit: 200 };
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
    const mailboxes = await this.listMailboxes({
      domain: domain.toLowerCase(),
      keyword: domain.toLowerCase(),
      workspaceId: ws,
    });
    const uids = mailboxes
      .map((m) => m.uid || m.id)
      .filter((x): x is string => Boolean(x));

    if (uids.length) {
      await this.cancelMailboxes(uids, {
        workspaceId: ws,
        domainUids:
          found.domain.uid || found.domain.id
            ? [String(found.domain.uid || found.domain.id)]
            : undefined,
      });
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
