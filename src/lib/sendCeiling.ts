import type { AppConfig } from "../config.js";
import { normalizeSenderEspFamily } from "./esp.js";
import {
  mailboxTypeCampaignCap,
  mailboxTypeWarmupCap,
} from "./mailboxType.js";
import {
  accountOnTenantTerlHold,
  type TenantTerlHoldStore,
} from "./tenantTerlHold.js";
import {
  TENANT_OUTBOUND_BLOCK_MPD,
  accountOnTenantOutboundHold,
  type TenantOutboundBlockStore,
} from "./tenantOutboundBlock.js";

/**
 * Smartlead's account `message_per_day` (written as `max_email_per_day`) is
 * the UI field labeled "Message Per Day (Warmups not included)". Warmup has
 * its own `warmup_max_count`. D11/D24: write `MESSAGE_PER_DAY` (30) for
 * Gmail/SMTP. D183: Outlook/Microsoft (`account.type` microsoft family,
 * typically `OUTLOOK`) write 15. D219: Azure/Entra (tidalstackco.com or
 * type:azure) write 2 campaign + 5 warmup; a 5.7.233 tenant hold writes 0
 * for 24 hours then the seat resumes its type cap. No learned 80% limit.
 * Do not drop the global constant to 15.
 */
export const OUTLOOK_MESSAGE_PER_DAY = 15;

export type SendCeilingStore = Partial<TenantTerlHoldStore> &
  Partial<TenantOutboundBlockStore> & {
    isBounceHoldAccount?(accountId: number, now?: Date): boolean;
  };

export function isOutlookMailboxType(
  type: string | null | undefined,
): boolean {
  return normalizeSenderEspFamily(type) === "microsoft";
}

export interface SendCeilingAccount {
  id?: number | null;
  type?: string | null;
  platform?: string | null;
  from_email?: string | null;
  email?: string | null;
  tags?: Array<{ tag_name?: string; name?: string }>;
}

export function mailboxWarmupPerDayTarget(
  account: SendCeilingAccount | null | undefined,
  config: Pick<AppConfig, "warmupTotalPerDay">,
): number {
  return mailboxTypeWarmupCap(account, config);
}

/**
 * Type default (Azure 2 / M365 15 / Google MESSAGE_PER_DAY). A live
 * TERRL 24h hold or a 5.1.8 tenant block writes 0. After the TERRL
 * window the type cap resumes. No 80% learned limit.
 */
export function mailboxMessagePerDayTarget(
  account: SendCeilingAccount | null | undefined,
  config: Pick<AppConfig, "messagePerDay">,
  store?: SendCeilingStore | null,
  now = new Date(),
): number {
  const typeCap = mailboxTypeCampaignCap(account, config);
  if (!account || !store) return typeCap;
  if (
    accountOnTenantOutboundHold(account, {
      isTenantOutboundBlockAccount: (id) =>
        store.isTenantOutboundBlockAccount?.(id) === true,
      isTenantOutboundBlockDomain: (domain) =>
        store.isTenantOutboundBlockDomain?.(domain) === true,
    })
  ) {
    return TENANT_OUTBOUND_BLOCK_MPD;
  }
  if (
    accountOnTenantTerlHold(
      account,
      {
        isTenantTerlHoldAccount: (id, at) =>
          store.isTenantTerlHoldAccount?.(id, at) === true,
        isTenantTerlHoldDomain: (domain, at) =>
          store.isTenantTerlHoldDomain?.(domain, at) === true,
      },
      now,
    )
  ) {
    return 0;
  }
  return typeCap;
}

export function totalDailySendCeiling(
  config: Pick<AppConfig, "messagePerDay" | "warmupTotalPerDay">,
): number {
  void config.warmupTotalPerDay;
  return config.messagePerDay;
}
