/** Live canon constants ported from v1. Do not invent new numbers. */

export const INSIGHT_CLIENT_ID = 582890;
export const SALESGLIDER_CLIENT_ID = 345263;
export const GOLIATH_CLIENT_ID = 548611;
export const TECHEVO_CLIENT_ID = 521881;
export const BCP_CLIENT_ID = 542838;
export const PARLAY_CLIENT_ID = 418274;
export const EMCOR_CLIENT_ID = 574020;
export const POWERGRYD_CLIENT_ID = 592842;
export const CULTURE_FITS_CLIENT_ID = 418275;
export const DEEP_ROOTS_NAMED_CLIENT_ID = 597783;

export const DEFAULT_MIN_FLOOR = 40;
export const DEFAULT_MIN_FLOOR_BY_CLIENT: Readonly<Record<number, number>> = {
  [TECHEVO_CLIENT_ID]: 30,
};

export const AZURE_STAFFABLE_WEIGHT = 0.1;
export const REGULAR_STAFFABLE_WEIGHT = 1;
export const AZURE_CAMPAIGN_PER_DAY = 2;
export const AZURE_WARMUP_PER_DAY = 5;
export const M365_CAMPAIGN_PER_DAY = 15;
export const GOOGLE_CAMPAIGN_PER_DAY = 30;
export const MIN_TIME_BTW_EMAILS = 10;
export const STEP2_DELAY_DAYS = 2;
export const WARMUP_DAYS = 21;
export const INBOX_THRESHOLD = 80;
export const LAUNCH_BAR = 85;
export const BOUNCE_RATE_THRESHOLD = 5;
export const BOUNCE_SAMPLE_FLOOR = 50;
export const ESP_MIX_FLOOR_RATIO = 1 / 3;
export const AZURE_ENTRA_DOMAINS = new Set(["tidalstackco.com"]);
export const WARMUP_GATE_EXEMPT_TAG = "WARMUP-GATE-EXEMPT";
export const CALLER_FOLLOWUP_SENDER_TAG = "GABE-VM-RESERVED";
export const CALLER_FOLLOWUP_NAME_PREFIX = "Gabe Calls |";
export const CALLER_FOLLOWUP_CAMPAIGN_IDS = [4085158, 4085159, 4085160] as const;
export const CALLER_FOLLOWUP_HOME_CLIENT_ID = SALESGLIDER_CLIENT_ID;
export const CALLER_FOLLOWUP_MIN_TIME_BTW_EMAILS = 3;
export const CALLER_FOLLOWUP_BRIDGE_SENDERS = [
  { email: "gabriel@sorrelquotaio.co", id: 24255344 },
  { email: "gabriel@goldworkio.co", id: 24255318 },
  { email: "gabriel@solacecorehq.co", id: 24255314 },
] as const;
export const CALLER_FOLLOWUP_OWNED_LOCAL_PART = "gabe";
export const POC_TAG = "POC";
export const POC_FILL_SEATS = 60;
export const QUIET_HOURS_TIMEZONE = "America/Chicago";
export const STAFFING_HOUR_START = 6;
export const STAFFING_HOUR_END = 20;
export const SEND_WINDOW_TIMEZONE = "America/New_York";
export const SEND_WINDOW_DAYS = [1, 2, 3, 4] as const;
export const SEND_WINDOW_START = "08:00";
export const SEND_WINDOW_END = "19:00";
export const TRACK_OFF = ["DONT_TRACK_EMAIL_OPEN", "DONT_TRACK_LINK_CLICK"] as const;
export const COPY_CANARY_FLEET_SIZE = 10;
export const COPY_CANARY_FLEET_MIN_GOOGLE_DOMAINS = 1;
export const COPY_CANARY_FLEET_MIN_MICROSOFT_DOMAINS = 1;
export const CANARY_COPY_TEST_PREFIX = "Canary copy:";
export const AUTO_PLACEMENT_TEST_PREFIX = "Auto:";
export const ISOLATION_DEADLINE_MS = 30 * 60 * 1000;
/** D219 — Microsoft 550 5.7.233 tenant hold. Rolling 24h, then type cap. */
export const TERL_HOLD_MS = 24 * 60 * 60 * 1000;
/** D257 — Smartlead account cap is 200/min; stay at 150 including SmartDelivery. */
export const SMARTLEAD_MAX_PER_MIN = 150;
export const SMARTLEAD_CONCURRENCY = 2;
export const SMARTLEAD_MIN_GAP_MS = 150;
/**
 * D278 — v2 shares the old wizard's Smartlead key. Stay well under the
 * D257 150/min account budget so shadow pulls cannot 429 production.
 */
export const V2_SMARTLEAD_MAX_PER_MIN = 20;
export const V2_SMARTLEAD_CONCURRENCY = 1;
export const V2_SMARTLEAD_MIN_GAP_MS = 3_000;
export const V2_SMARTLEAD_PAGE_DELAY_MS = 2_500;
export const V2_SMARTLEAD_429_MAX_ATTEMPTS = 4;
export const V2_INVENTORY_MAX_AGE_MS = 30 * 60 * 1000;
export const QA_LEASE_NAME = "qa";
export const QA_LEASE_TTL_MS = 12 * 60 * 1000;
export const PREWARMED_DOMAINS = [
  "crosslaunchco.com",
  "crossscaleco.com",
  "cleartechco.com",
] as const;

export const CONTAMINATED_CANARY_LOCAL_PARTS = [
  "leilasanchez",
  "kwamelopez",
  "aminarodriguez",
  "marcusrossi",
  "jasminecosta",
  "ninajefferson",
] as const;

export const CONTAMINATED_CANARY_DOMAINS = [
  "getcrosslaunchco.info",
  "crosslaunchcoget.info",
] as const;

export const CLIENT_NAMED_DOMAIN_SLUGS = [
  "goliathcybersecurity",
  "techevolution",
  "salesglider",
  "boldercyber",
  "boldercyper",
  "joshosborn",
  "cornerstone",
  "deeproots",
  "powergryd",
  "goliath",
  "insight",
  "parlay",
  "nutter",
  "vector",
  "emcor",
  "roofs",
  "mesa",
] as const;

export const CANON_CORE_KINDS = [
  "understaffed",
  "esp_mix",
  "cross_client_membership",
  "under_warmed",
  "missing_signature_tag",
  "mailbox_sig",
  "insight_shared_staff",
  "mailbox_gap",
  "mailbox_volume",
  "no_placement_test",
  "missing_canary",
  "inbox_missing_known_good",
  "merge_tag_blank",
  "step2_delay",
  "generic_idle",
  "generic_multi_client",
  "generic_outside_table",
  "canary_on_live",
  "canary_warmup_on",
  "ugly_without_isolation",
  "isolation_deadline",
  "duplicate_canary_test",
  "esp_matching",
  "plain_text",
  "html_body",
  "send_window",
] as const;

export function defaultReleasedCanaryEmails(): string[] {
  const out: string[] = [];
  for (const local of CONTAMINATED_CANARY_LOCAL_PARTS) {
    for (const domain of CONTAMINATED_CANARY_DOMAINS) {
      out.push(`${local}@${domain}`);
    }
  }
  return out;
}

export function minFloorForClient(clientId: number | null | undefined): number {
  if (typeof clientId === "number" && clientId in DEFAULT_MIN_FLOOR_BY_CLIENT) {
    return DEFAULT_MIN_FLOOR_BY_CLIENT[clientId]!;
  }
  return DEFAULT_MIN_FLOOR;
}
