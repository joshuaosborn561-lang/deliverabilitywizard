import type { AppConfig } from "../config.js";
import type {
  SmartleadAccountWithCampaigns,
  SmartleadClientRecord,
} from "../clients/smartlead.js";
import {
  accountEmail,
  clientDisplayName,
} from "../clients/smartlead.js";
import type { StateStore } from "../state/store.js";
import { POWERGRYD_CLIENT_ID } from "./namedClientIds.js";
import {
  brandFromClientDisplayName,
  clientBrandList,
  findForeignBrand,
} from "./clientBrand.js";
import { isClientNamedDomain } from "./clientNamedDomain.js";
import { isGenericMailbox } from "./clientInbox.js";
import {
  isRealNamedClientId,
  preferredGenericOwnerId,
} from "./dedicatedGeneric.js";
import { emailDomainOf } from "./isolationDomain.js";
import { isFreedPowerGrydAttachBlocked } from "./powerGrydFreedCleanup.js";
import { signatureHay } from "./signatureQa.js";
import { isStaffableSender } from "./staffableSender.js";
import { owesWarmup } from "../services/warmupGate.js";

/**
 * D258 / D285 — PowerGRYD branded-warming / empty-by-design.
 *
 * ON when no named PowerGRYD seat is staffable yet (they are still
 * warming, or none exist). While ON, staffing must not put a
 * foreign-signature / foreign-client generic onto a PowerGRYD
 * ACTIVE campaign. This is not a never-generics rule (D256/D285):
 * PowerGRYD takes free-pool generics like any named client.
 * D283 still blocks Onboarding-freed seats (SL-null leftover
 * `powergryd_dedicated`) from flipping back onto 592842.
 */

export function isPowerGrydNamedSeat(
  account: SmartleadAccountWithCampaigns,
  email: string,
  config: Pick<
    AppConfig,
    "extraGenericMailboxes" | "extraGenericDomains" | "prewarmedDomains"
  >,
  state: Pick<StateStore, "getPoolMailbox"> & {
    isCopyCanary?: StateStore["isCopyCanary"];
    getCopyCanaryFleet?: StateStore["getCopyCanaryFleet"];
  },
  clientId = POWERGRYD_CLIENT_ID,
): boolean {
  if (isGenericMailbox(account, email, config, state)) return false;
  if (account.client_id === clientId) return true;
  const domain = emailDomainOf(email);
  return Boolean(domain && isClientNamedDomain(domain) && account.client_id === clientId);
}

export function staffableNamedPowerGrydCount(input: {
  accounts: SmartleadAccountWithCampaigns[];
  config: Pick<
    AppConfig,
    | "extraGenericMailboxes"
    | "extraGenericDomains"
    | "prewarmedDomains"
    | "campaignMinWarmupDays"
    | "freshInboxWarmupDays"
  >;
  state: Pick<StateStore, "getPoolMailbox" | "isCopyCanary"> & {
    getCopyCanaryFleet?: StateStore["getCopyCanaryFleet"];
  };
  clientId?: number;
}): number {
  const clientId = input.clientId ?? POWERGRYD_CLIENT_ID;
  let n = 0;
  for (const account of input.accounts) {
    const email = accountEmail(account);
    if (!email) continue;
    if (!isPowerGrydNamedSeat(account, email, input.config, input.state, clientId)) {
      continue;
    }
    if (owesWarmup(account, email, input.config, input.state)) continue;
    if (
      !isStaffableSender(account, {
        copyCanary: Boolean(input.state.isCopyCanary?.(email)),
      })
    ) {
      continue;
    }
    n += 1;
  }
  return n;
}

export function isPowerGrydEmptyByDesign(input: {
  accounts: SmartleadAccountWithCampaigns[];
  config: Pick<
    AppConfig,
    | "extraGenericMailboxes"
    | "extraGenericDomains"
    | "prewarmedDomains"
    | "campaignMinWarmupDays"
    | "freshInboxWarmupDays"
  >;
  state: Pick<StateStore, "getPoolMailbox" | "isCopyCanary"> & {
    getCopyCanaryFleet?: StateStore["getCopyCanaryFleet"];
  };
  clientId?: number;
}): boolean {
  return staffableNamedPowerGrydCount(input) < 1;
}

export function genericBlockedOnPowerGrydStaffing(input: {
  account: SmartleadAccountWithCampaigns;
  email: string;
  targetClientId: number;
  emptyByDesign: boolean;
  powerGrydClientId?: number;
  powerGrydBrand?: string;
  allBrands?: string[];
  mailboxClientId?: number | null;
  assignedClientId?: number | null;
  assignedReason?: string | null;
  releaseHistory?: Array<{ reason?: string | null }>;
  isMarkerClientId?: (id: number | null | undefined) => boolean;
}): boolean {
  const powerId = input.powerGrydClientId ?? POWERGRYD_CLIENT_ID;
  if (input.targetClientId !== powerId) return false;
  if (
    isFreedPowerGrydAttachBlocked({
      mailboxClientId: input.mailboxClientId ?? input.account.client_id,
      assignedClientId: input.assignedClientId,
      assignedReason: input.assignedReason,
      releaseHistory: input.releaseHistory,
      powerGrydClientId: powerId,
    })
  ) {
    return true;
  }
  const liveOwner = preferredGenericOwnerId({
    mailboxClientId: input.mailboxClientId ?? input.account.client_id,
    assignedClientId: input.assignedClientId,
    assignedReason: input.assignedReason,
    isMarkerClientId: input.isMarkerClientId,
  });
  if (
    liveOwner != null &&
    liveOwner !== powerId &&
    isRealNamedClientId(liveOwner, input.isMarkerClientId)
  ) {
    return true;
  }
  if (!input.emptyByDesign) return false;
  // D292 — leftover foreign signatures on a FREE ledger seat are
  // rewritten to PowerGRYD on assign. Empty-by-design must not refuse
  // rotating those in. A live foreign owner still blocks above.
  if (input.assignedClientId == null && liveOwner == null) return false;
  const brand = String(input.powerGrydBrand ?? "PowerGRYD").trim();
  const brands = input.allBrands ?? [];
  if (!brand || brands.length === 0) return false;
  const hay = signatureHay({
    fromName: input.account.from_name,
    signature: input.account.signature,
  });
  return findForeignBrand(hay, brand, brands) != null;
}

export function powerGrydBrandFromClients(
  clients: SmartleadClientRecord[],
  clientId = POWERGRYD_CLIENT_ID,
): string {
  const row = clients.find((client) => client.id === clientId);
  if (!row) return "PowerGRYD";
  return brandFromClientDisplayName(clientDisplayName(row)) || "PowerGRYD";
}

export function brandsFromClients(clients: SmartleadClientRecord[]): string[] {
  return clientBrandList(clients);
}
