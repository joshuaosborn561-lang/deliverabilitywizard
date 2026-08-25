/**
 * D80 — our campaign bounce auto-stop, not Smartlead's.
 *
 * Lifetime campaign sends (leads emailed) are the sample. Below 100 the
 * rate is noise. 100–499 uses 20%. 500 and up uses 7%. Smartlead's own
 * bounce_autopause_threshold stays off (100).
 */

export const CAMPAIGN_BOUNCE_AUTOSTOP_MIN_SENT = 100;
export const CAMPAIGN_BOUNCE_AUTOSTOP_HIGH_VOLUME_SENT = 500;
export const CAMPAIGN_BOUNCE_AUTOSTOP_MID_PERCENT = 20;
export const CAMPAIGN_BOUNCE_AUTOSTOP_HIGH_PERCENT = 7;

/** Percent Smartlead will not trip on. Converge this instead of 5/7/20. */
export const SMARTLEAD_BOUNCE_AUTOPAUSE_OFF_PERCENT = 100;

export interface BounceAutostopBands {
  minSent: number;
  highVolumeSent: number;
  midPercent: number;
  highPercent: number;
}

export const DEFAULT_BOUNCE_AUTOSTOP_BANDS: BounceAutostopBands = {
  minSent: CAMPAIGN_BOUNCE_AUTOSTOP_MIN_SENT,
  highVolumeSent: CAMPAIGN_BOUNCE_AUTOSTOP_HIGH_VOLUME_SENT,
  midPercent: CAMPAIGN_BOUNCE_AUTOSTOP_MID_PERCENT,
  highPercent: CAMPAIGN_BOUNCE_AUTOSTOP_HIGH_PERCENT,
};

export function campaignBounceAutostopThreshold(
  sent: number,
  bands: BounceAutostopBands = DEFAULT_BOUNCE_AUTOSTOP_BANDS,
): number | null {
  if (sent < bands.minSent) return null;
  if (sent < bands.highVolumeSent) return bands.midPercent;
  return bands.highPercent;
}

export function shouldAutostopCampaignForBounce(
  sent: number,
  bounceRate: number,
  bands: BounceAutostopBands = DEFAULT_BOUNCE_AUTOSTOP_BANDS,
): boolean {
  const threshold = campaignBounceAutostopThreshold(sent, bands);
  if (threshold == null) return false;
  return bounceRate > threshold;
}
