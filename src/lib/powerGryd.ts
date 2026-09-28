/**
 * D204 — PowerGryd (Smartlead client 592842) is a POC client, same
 * standing as Goliath. Josh dedicated 40 generics to it: no pods,
 * all 40 on every PowerGryd campaign, never peel / re-point /
 * rewrite away from PowerGRYD.
 *
 * These seats live on pool-plan domains. Without this named-id
 * protect, D200 exclusive-attach (one-client / client-rest / top-up)
 * peels them to one campaign and D173 / signature writers can
 * re-own them to Bolder 542838.
 *
 * Rotating-pool owner stays Goliath. Do not dump free-pool generics
 * onto PowerGryd. Do not START / PAUSE / Retire / teardown live
 * PowerGryd by automation — Josh cancels the client API when the
 * POC ends.
 */

export const POWERGRYD_CLIENT_ID = 592842;
export const POWERGRYD_BRAND = "PowerGRYD";
/** Bolder — the live re-point these seats must never take (D204). */
export const BOLDER_CLIENT_ID = 542838;

/** Issue #243 — the 40 dedicated PowerGryd seats. */
export const POWERGRYD_MAILBOX_IDS: readonly number[] = [
  21592105, 21592107, 21592108, 21592203, 21592206, 21592209, 21592210,
  21592211, 21592217, 21592221, 21592230, 21592515, 21592521, 21592526,
  21592535, 21592557, 21592567, 21600936, 21648667, 21648669, 21648676,
  21648697, 21648698, 21648702, 21648714, 21648715, 21648721, 21648722,
  21648773, 21648777, 21648780, 21648794, 21831345, 21831350, 21831351,
  21831354, 21831355, 21831401, 21831457, 21831474,
];

/** Issue #243 — the 12 PowerGryd campaigns. */
export const POWERGRYD_CAMPAIGN_IDS: readonly number[] = [
  4005218, 4005220, 4005223, 4005225, 4005226, 4005228, 4005229, 4005231,
  4005232, 4005233, 4005234, 4005235,
];

const MAILBOX_ID_SET = new Set(POWERGRYD_MAILBOX_IDS);
const CAMPAIGN_ID_SET = new Set(POWERGRYD_CAMPAIGN_IDS);

export function isPowerGrydClientId(id: number | null | undefined): boolean {
  return id === POWERGRYD_CLIENT_ID;
}

export function isPowerGrydMailboxId(id: number | null | undefined): boolean {
  return typeof id === "number" && MAILBOX_ID_SET.has(id);
}

export function isPowerGrydCampaignId(id: number | null | undefined): boolean {
  return typeof id === "number" && CAMPAIGN_ID_SET.has(id);
}

export function isPowerGrydHay(hay: string | null | undefined): boolean {
  const text = String(hay ?? "").toLowerCase();
  return text.includes("powergryd") || text.includes("power gryd");
}

export function isPowerGrydDedicatedSeat(account: {
  id?: number | null;
}): boolean {
  return isPowerGrydMailboxId(account.id);
}

/** Two-line Name / PowerGRYD. Never Bolder / SalesGlider / Goliath. */
export function powerGrydMailboxSignature(
  fromName: string | null | undefined,
): string | null {
  const name = String(fromName ?? "").trim();
  if (!name) return null;
  return `${name}\n${POWERGRYD_BRAND}`;
}

/**
 * Leave-alone: automation must not START / PAUSE / Retire / teardown
 * live PowerGryd. Josh cancels the client API when the POC ends.
 */
export function isPowerGrydLeaveAlone(input: {
  campaignId?: number | null;
  clientId?: number | null;
  campaignName?: string | null;
  clientName?: string | null;
}): boolean {
  if (isPowerGrydClientId(input.clientId)) return true;
  if (isPowerGrydCampaignId(input.campaignId)) return true;
  return isPowerGrydHay(`${input.campaignName ?? ""} ${input.clientName ?? ""}`);
}
