/**
 * D173 / D181 — open a domain-failure ask that respects ownership.
 * Goliath / client 548611 follows the same Retire path as every
 * other client (D181 reversed D174 never-retire). Cover-buy without
 * retire remains the fail-#1 buy-ahead path, not a protection carve-out.
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
  replacementParentForRetiredDomain,
} from "./retireReplacement.js";
import { isolationAskBlocksDomain } from "./attachBlock.js";
import {
  buildIsolationAction,
  domainAlreadyRetired,
  requestIsolationAction,
  burnStrikeKey,
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
  if (domainAlreadyRetired(input.store, host)) {
    return { opened: null, covered: false };
  }
  const parent = replacementParentForRetiredDomain(host, input.config, {
    kind: input.preferRetire ? "retire_domain" : "buy_domains",
    owner,
  });
  const ownerDetail = ownerOnActionDetail(owner);
  const failingEmails = Array.isArray(input.extraDetail?.failingEmails)
    ? (input.extraDetail.failingEmails as string[])
    : undefined;
  const as42004 = Boolean(input.extraDetail?.as42004);

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
          strikeKey: burnStrikeKey({
            kind: "retire_domain",
            domain: host,
            failingEmails,
            as42004,
          }),
          ...ownerDetail,
          ...input.extraDetail,
        },
      }),
    });
    persistAskAttachBlock(input.store, host, opened);
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
        strikeKey: burnStrikeKey({
          kind: "buy_domains",
          domain: host,
          failingEmails,
          as42004,
        }),
        ...ownerDetail,
        ...input.extraDetail,
      },
    }),
  });
  persistAskAttachBlock(input.store, host, opened);
  return { opened, covered: false };
}

function persistAskAttachBlock(
  store: StateStore,
  domain: string,
  action: IsolationActionRecord | null,
): void {
  if (!action) return;
  if (!isolationAskBlocksDomain(domain, [action])) return;
  store.upsertAttachBlock({
    domain,
    reason: action.kind === "retire_domain" ? "burned" : "sender_blocked",
    source: `ask:${action.kind}:${action.status}`,
  });
}
