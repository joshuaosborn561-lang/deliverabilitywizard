/**
 * D301 — each client's InboxKit Google/Microsoft split is the POD
 * ESP-mix target. Smartlead person-names map to InboxKit workspaces.
 * Fall back to the D203 ~1/3 floor only when this cache has no row.
 */

import type { InboxKitClient } from "../clients/inboxkit.js";
import {
  inboxkitStatusOf,
  isLapsedInboxkitStatus,
  isScheduledCancelStatus,
  type InboxkitLicenseMailbox,
} from "./inboxkitLicense.js";
import { workspaceMatchesClientName } from "./inboxkitWorkspace.js";

export const INBOXKIT_CLIENT_SPLIT_TTL_MS = 60 * 60 * 1000;

/** Smartlead client → InboxKit workspace (D301). */
export const SMARTLEAD_TO_INBOXKIT_WORKSPACE = [
  { smartlead: "Corey Tapper", inboxkit: "TechEvolution" },
  { smartlead: "Kyle Peterson", inboxkit: "Roofs Peterson" },
  { smartlead: "Mike Trpkosh", inboxkit: "BolderCyberPartners" },
  { smartlead: "Myles McIntosh", inboxkit: "EMCOR" },
  { smartlead: "Randy Haba", inboxkit: "Parlay" },
] as const;

const WORKSPACE_ALIASES: ReadonlyArray<[string, string]> = [
  ["coreytapper", "TechEvolution"],
  ["techevolution", "TechEvolution"],
  ["techevo", "TechEvolution"],
  ["kylepeterson", "Roofs Peterson"],
  ["roofspeterson", "Roofs Peterson"],
  ["roofsbypeterson", "Roofs Peterson"],
  ["miketrpkosh", "BolderCyberPartners"],
  ["boldercyberpartners", "BolderCyberPartners"],
  ["boldercyber", "BolderCyberPartners"],
  ["mylesmcintosh", "EMCOR"],
  ["emcor", "EMCOR"],
  ["randyhaba", "Parlay"],
  ["parlay", "Parlay"],
  ["parlaytech", "Parlay"],
];

export type InboxkitEspSplit = {
  google: number;
  microsoft: number;
  total: number;
  microsoftShare: number;
};

export type InboxkitSplitSource = Pick<
  InboxKitClient,
  "listWorkspaces" | "listAllMailboxes"
>;

export type InboxkitSplitClient = {
  name?: string | null;
  logo?: string | null;
};

export function normalizeInboxkitName(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function inboxkitWorkspaceForClient(
  client: string | InboxkitSplitClient | null | undefined,
): string | undefined {
  const names =
    typeof client === "string"
      ? [client]
      : [client?.name, client?.logo].filter(
          (row): row is string => Boolean(row && String(row).trim()),
        );
  for (const name of names) {
    const key = normalizeInboxkitName(name);
    if (!key) continue;
    for (const [alias, workspace] of WORKSPACE_ALIASES) {
      if (key === alias) return workspace;
    }
    for (const row of SMARTLEAD_TO_INBOXKIT_WORKSPACE) {
      if (normalizeInboxkitName(row.smartlead) === key) return row.inboxkit;
      if (normalizeInboxkitName(row.inboxkit) === key) return row.inboxkit;
    }
    for (const row of SMARTLEAD_TO_INBOXKIT_WORKSPACE) {
      if (
        workspaceMatchesClientName(row.inboxkit, name) ||
        workspaceMatchesClientName(row.smartlead, name)
      ) {
        return row.inboxkit;
      }
    }
  }
  return undefined;
}

export function inboxkitMailboxCountsTowardEspMix(
  mailbox: Pick<InboxkitLicenseMailbox, "status" | "license_status">,
): boolean {
  const status = inboxkitStatusOf(mailbox);
  if (isLapsedInboxkitStatus(status)) return false;
  if (isScheduledCancelStatus(status)) return false;
  return true;
}

export function inboxkitPlatformFamily(
  platform: string | null | undefined,
): "google" | "microsoft" | "other" {
  const p = String(platform ?? "")
    .trim()
    .toUpperCase();
  if (!p) return "other";
  if (p.includes("GOOGLE") || p.includes("GMAIL") || p.includes("GSUITE")) {
    return "google";
  }
  if (
    p.includes("MICROSOFT") ||
    p.includes("OUTLOOK") ||
    p.includes("O365") ||
    p.includes("M365") ||
    p.includes("AZURE")
  ) {
    return "microsoft";
  }
  return "other";
}

export function countInboxkitEspSplit(
  mailboxes: Array<{
    platform?: string | null;
    status?: string | null;
    license_status?: string | null;
  }>,
): InboxkitEspSplit {
  let google = 0;
  let microsoft = 0;
  for (const row of mailboxes) {
    if (!inboxkitMailboxCountsTowardEspMix(row)) continue;
    const family = inboxkitPlatformFamily(row.platform);
    if (family === "google") google += 1;
    else if (family === "microsoft") microsoft += 1;
  }
  const total = google + microsoft;
  return {
    google,
    microsoft,
    total,
    microsoftShare: total > 0 ? microsoft / total : 0,
  };
}

export class InboxkitClientSplitCache {
  private loadedAt = 0;
  private byWorkspace = new Map<string, InboxkitEspSplit>();
  private loadPromise: Promise<void> | null = null;

  constructor(
    private readonly inboxkit?: InboxkitSplitSource | null,
    private readonly ttlMs: number = INBOXKIT_CLIENT_SPLIT_TTL_MS,
  ) {}

  /** Test helper — skip InboxKit HTTP. */
  seed(
    splits: Iterable<{
      workspace: string;
      google: number;
      microsoft: number;
    }>,
  ): void {
    this.byWorkspace.clear();
    for (const row of splits) {
      this.byWorkspace.set(
        normalizeInboxkitName(row.workspace),
        countInboxkitEspSplit([
          ...Array.from({ length: row.google }, () => ({
            platform: "GOOGLE",
            status: "active",
          })),
          ...Array.from({ length: row.microsoft }, () => ({
            platform: "MICROSOFT",
            status: "active",
          })),
        ]),
      );
    }
    this.loadedAt = Date.now();
  }

  async ensureLoaded(): Promise<void> {
    if (this.loadedAt > 0 && Date.now() - this.loadedAt < this.ttlMs) return;
    if (!this.inboxkit) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.refresh().finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  shareForClient(
    client: string | InboxkitSplitClient | null | undefined,
  ): number | undefined {
    const workspace = inboxkitWorkspaceForClient(client);
    if (!workspace) return undefined;
    const split = this.byWorkspace.get(normalizeInboxkitName(workspace));
    if (!split || split.total <= 0) return undefined;
    return split.microsoftShare;
  }

  splitForClient(
    client: string | InboxkitSplitClient | null | undefined,
  ): InboxkitEspSplit | undefined {
    const workspace = inboxkitWorkspaceForClient(client);
    if (!workspace) return undefined;
    const split = this.byWorkspace.get(normalizeInboxkitName(workspace));
    if (!split || split.total <= 0) return undefined;
    return split;
  }

  private async refresh(): Promise<void> {
    if (!this.inboxkit) return;
    try {
      const workspaces = await this.inboxkit.listWorkspaces();
      const next = new Map<string, InboxkitEspSplit>();
      for (const workspace of workspaces) {
        const id = String(workspace.uid || workspace.id || "").trim();
        const name = String(workspace.name || "").trim();
        if (!id || !name) continue;
        const rows = await this.inboxkit.listAllMailboxes(id);
        next.set(normalizeInboxkitName(name), countInboxkitEspSplit(rows));
      }
      this.byWorkspace = next;
      this.loadedAt = Date.now();
      console.log(`[inboxkit-split] loaded ${next.size} workspace(s)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[inboxkit-split] load failed: ${message}`);
      if (this.byWorkspace.size > 0) this.loadedAt = Date.now();
    }
  }
}
