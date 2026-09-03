/**
 * D173 / D174 — open a domain-failure ask that respects ownership
 * and the protected-client never-retire rule. Protected inventory
 * degrades to a buy/cover ask and the Slack card says why.
 */
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";
import type { SmartleadClientRecord } from "../clients/smartlead.js";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { IsolationActionRecord } from "../state/isolationState.js";
import {
  buildDomainOwnerCache,
  resolveDomainOwner,
  type DomainOwnerRecord,
} from "./domainOwnership.js";
import {
  isProtectedOwner,
  protectedRetireReason,
  type ProtectedClientConfig,
} from "./protectedClient.js";
import {
  replacementParentForRetiredDomain,
} from "./retireReplacement.js";
import {
  buildIsolationAction,
  domainRecentlyRetired,
  requestIsolationAction,
} from "./isolationActions.js";

export function refreshDomainOwnerCache(
  store: Pick<StateStore, "replaceDomainOwners" | "isMarkerClientId">,
  accounts: SmartleadAccountWithCampaigns[],
  clients: SmartleadClientRecord[],
  config: Pick<AppConfig, "extraGenericDomains" | "prewarmedDomains">,
): Record<string, DomainOwnerRecord> {
  const owners = buildDomainOwnerCache(accounts, clients, config, {
    isMarkerClientId: (id) => store.isMarkerClientId(id),
  });
  store.replaceDomainOwners(owners);
  return owners;
}

export function ownerOfDomain(
  domain: string,
  store: Pick<StateStore, "getDomainOwner" | "isMarkerClientId">,
  accounts?: SmartleadAccountWithCampaigns[],
  clients?: SmartleadClientRecord[],
  config?: Pick<AppConfig, "extraGenericDomains" | "prewarmedDomains">,
): DomainOwnerRecord | undefined {
  const host = domain.trim().toLowerCase();
  if (accounts && config) {
    return resolveDomainOwner(host, accounts, clients ?? [], config, {
      isMarkerClientId: (id) => store.isMarkerClientId?.(id) ?? false,
    });
  }
  return store.getDomainOwner(host);
}

export function ownerOnActionDetail(
  owner: DomainOwnerRecord | undefined,
): Record<string, unknown> {
  if (!owner) return {};
  return {
    ownerKind: owner.kind,
    ownerClientId: owner.clientId,
    ownerClientName: owner.clientName,
    ownerConflict: owner.conflict,
  };
}

export function ownerFromActionDetail(
  detail: Record<string, unknown>,
): DomainOwnerRecord | undefined {
  const kind = String(detail.ownerKind ?? "");
  if (kind !== "client" && kind !== "generic" && kind !== "unknown") {
    return undefined;
  }
  const clientId = Number(detail.ownerClientId);
  return {
    domain: String(detail.domain ?? detail.retiredDomain ?? ""),
    kind,
    clientId: Number.isFinite(clientId) && clientId > 0 ? clientId : null,
    clientName:
      typeof detail.ownerClientName === "string" ? detail.ownerClientName : null,
    mailboxCount: 0,
    uniqueClientIds: Number.isFinite(clientId) && clientId > 0 ? [clientId] : [],
    planSaysGeneric: false,
    conflict: Boolean(detail.ownerConflict),
    source: "cache",
    updatedAt: "",
  };
}

export function shouldRefuseRetire(
  owner: DomainOwnerRecord | undefined,
  config: ProtectedClientConfig,
): boolean {
  return isProtectedOwner(owner, config);
}

export async function requestRetireOrCover(input: {
  store: StateStore;
  slack: Pick<SlackClient, "notifyIsolationAction">;
  config: AppConfig;
  domain: string;
  preferRetire: boolean;
  proof: string;
  owner?: DomainOwnerRecord;
  extraDetail?: Record<string, unknown>;
}): Promise<{
  opened: IsolationActionRecord | null;
  covered: boolean;
  reason?: string;
}> {
  const host = input.domain.trim().toLowerCase();
  const owner = input.owner ?? input.store.getDomainOwner(host);
  const refuse = shouldRefuseRetire(owner, input.config);
  if (
    input.preferRetire &&
    !refuse &&
    domainRecentlyRetired(input.store, host)
  ) {
    return { opened: null, covered: false };
  }
  const parent = replacementParentForRetiredDomain(host, input.config, {
    kind: refuse || !input.preferRetire ? "buy_domains" : "retire_domain",
    owner,
  });
  const ownerDetail = ownerOnActionDetail(owner);

  if (refuse) {
    const reason = protectedRetireReason(owner, host);
    const opened = await requestIsolationAction({
      store: input.store,
      slack: input.slack,
      action: buildIsolationAction({
        kind: "buy_domains",
        title: `Buy cover for ${host} — not retiring (protected client)`,
        proof: [input.proof, reason].filter(Boolean).join("\n"),
        detail: {
          domain: host,
          quantity: 1,
          parentDomain: parent,
          coverOnly: true,
          protectedClient: true,
          ...ownerDetail,
          ...input.extraDetail,
        },
      }),
    });
    return { opened, covered: true, reason };
  }

  if (input.preferRetire) {
    const opened = await requestIsolationAction({
      store: input.store,
      slack: input.slack,
      action: buildIsolationAction({
        kind: "retire_domain",
        title: `Retire ${host}`,
        proof: input.proof,
        detail: {
          domain: host,
          quantity: 1,
          parentDomain: parent,
          ...ownerDetail,
          ...input.extraDetail,
        },
      }),
    });
    return { opened, covered: false };
  }

  const opened = await requestIsolationAction({
    store: input.store,
    slack: input.slack,
    action: buildIsolationAction({
      kind: "buy_domains",
      title: `Buy a replacement for ${host}`,
      proof: input.proof,
      detail: {
        domain: host,
        quantity: 1,
        parentDomain: parent,
        ...ownerDetail,
        ...input.extraDetail,
      },
    }),
  });
  return { opened, covered: false };
}

/**
 * Convert already-open pending retires for protected clients into
 * buy/cover asks so the Slack button cannot pull their inboxes.
 */
export async function neutralizeProtectedRetireAsks(input: {
  store: StateStore;
  slack: Pick<SlackClient, "notifyIsolationAction">;
  config: AppConfig;
  accounts?: SmartleadAccountWithCampaigns[];
  clients?: SmartleadClientRecord[];
}): Promise<number> {
  let converted = 0;
  for (const action of input.store.listIsolationActions()) {
    if (action.kind !== "retire_domain" || action.status !== "pending") continue;
    const domain = String(action.detail.domain ?? "").toLowerCase();
    if (!domain) continue;
    const owner = ownerOfDomain(
      domain,
      input.store,
      input.accounts,
      input.clients,
      input.config,
    );
    if (!shouldRefuseRetire(owner, input.config)) continue;
    const reason = protectedRetireReason(owner, domain);
    input.store.upsertIsolationAction({
      ...action,
      status: "denied",
      decidedAt: new Date().toISOString(),
      decidedBy: "system",
      error: reason,
    });
    if (owner) input.store.upsertDomainOwner(owner);
    await requestRetireOrCover({
      store: input.store,
      slack: input.slack,
      config: input.config,
      domain,
      preferRetire: false,
      proof: action.proof,
      owner,
    });
    converted += 1;
    console.warn(
      `[retire-guard] denied pending retire for ${domain} — ${reason}`,
    );
  }
  return converted;
}
