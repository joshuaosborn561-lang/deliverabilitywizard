/**
 * D265 — replacement / cover buys go into the client's InboxKit
 * workspace, never the generic-pool workspace, unless the burned
 * domain itself is generic/pool.
 */

export interface InboxkitWorkspaceRef {
  id?: string;
  uid?: string;
  name?: string;
}

export interface ReplacementWorkspacePick {
  workspaceId?: string;
  workspaceName?: string;
  reason: string;
  generic: boolean;
}

function workspaceIdOf(row: InboxkitWorkspaceRef): string {
  return String(row.uid || row.id || "").trim();
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function isGenericOwnerKind(ownerKind: string | undefined): boolean {
  const kind = String(ownerKind ?? "").toLowerCase();
  return kind === "generic" || kind === "pool";
}

export function workspaceMatchesClientName(
  workspaceName: string | undefined,
  clientName: string | undefined,
): boolean {
  const ws = normalizeName(workspaceName ?? "");
  const client = normalizeName(clientName ?? "");
  if (!ws || !client) return false;
  return ws === client || ws.includes(client) || client.includes(ws);
}

/**
 * Pick the InboxKit workspace for a replacement / cover buy.
 * A client-owned domain never falls through to the generic pool.
 */
export function pickReplacementWorkspace(input: {
  ownerKind?: string;
  ownerClientName?: string;
  sourceDomainWorkspaceId?: string;
  sourceDomainWorkspaceName?: string;
  workspaces?: InboxkitWorkspaceRef[];
  genericPoolWorkspaceId?: string;
}): ReplacementWorkspacePick {
  const genericId = String(input.genericPoolWorkspaceId ?? "").trim();
  const sourceId = String(input.sourceDomainWorkspaceId ?? "").trim();
  const genericOwner = isGenericOwnerKind(input.ownerKind);
  const clientName = String(input.ownerClientName ?? "").trim();

  if (genericOwner || (!clientName && !sourceId)) {
    return {
      workspaceId: genericId || undefined,
      workspaceName: "Generic pool",
      reason: "generic/pool domain uses the generic-pool workspace",
      generic: true,
    };
  }

  if (sourceId && sourceId !== genericId) {
    return {
      workspaceId: sourceId,
      workspaceName: input.sourceDomainWorkspaceName,
      reason: "retired domain already lives in this client workspace",
      generic: false,
    };
  }

  for (const row of input.workspaces ?? []) {
    const id = workspaceIdOf(row);
    if (!id || id === genericId) continue;
    if (workspaceMatchesClientName(row.name, clientName)) {
      return {
        workspaceId: id,
        workspaceName: row.name,
        reason: `matched InboxKit workspace name to ${clientName}`,
        generic: false,
      };
    }
  }

  if (sourceId && sourceId === genericId && genericOwner) {
    return {
      workspaceId: genericId,
      workspaceName: "Generic pool",
      reason: "source domain is in the generic pool",
      generic: true,
    };
  }

  return {
    workspaceId: undefined,
    reason: clientName
      ? `no InboxKit workspace matched client ${clientName} — will not buy into the generic pool`
      : "client workspace unknown — will not buy into the generic pool",
    generic: false,
  };
}

export function mailboxOrderFollowup(input: {
  mailboxesOrdered: number;
  awaitingNameservers: boolean;
}): string | undefined {
  if (!input.awaitingNameservers) return undefined;
  if (input.mailboxesOrdered > 0) {
    return "Some nameservers are still catching up; remaining mailbox orders finish themselves — no second tap.";
  }
  return "Nameservers are still catching up; I will finish the mailbox order myself — no second tap.";
}
