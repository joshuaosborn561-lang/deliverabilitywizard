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
} from "./clientBrand.js";
import { isClientNamedDomain } from "./clientNamedDomain.js";
import { isGenericMailbox } from "./clientInbox.js";
import { emailDomainOf } from "./isolationDomain.js";
import { isStaffableSender } from "./staffableSender.js";
import { owesWarmup } from "../services/warmupGate.js";

/**
 * D258 / D283 — PowerGRYD branded-warming / empty-by-design, plus
 * the hard rule: never staff fleet-pool generics onto PowerGRYD.
 *
 * Empty-by-design is ON when no named PowerGRYD seat is staffable
 * yet (they are still warming, or none exist). D283 forbids every
 * generic attach onto 592842 — branded or free-pool — so Onboarding-
 * freed seats cannot flip back. Named PowerGRYD seats still fan-out
 * onto PowerGRYD campaigns.
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
  isMarkerClientId?: (id: number | null | undefined) => boolean;
}): boolean {
  const powerId = input.powerGrydClientId ?? POWERGRYD_CLIENT_ID;
  if (input.targetClientId !== powerId) return false;
  // D283 — never staff generics onto PowerGRYD, including a stale
  // powergryd_dedicated pool row whose live Smartlead client_id is null.
  return true;
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
