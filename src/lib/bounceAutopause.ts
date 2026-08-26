/**
 * Smartlead campaign settings helpers.
 *
 * D80 — do not turn Smartlead bounce auto-pause on. Writes use 100 (off).
 * Live pause is CampaignBounceAutostopService (100/20 then 500/7).
 * Name-band helpers remain for old campaign titles; they are not a
 * write rule.
 */

const UNDER_1K = /under[-_\s]?1k\b/i;
const OVER_1K = /over[-_\s]?1k\b/i;

const TRACK_REWRITE: Record<string, string> = {
  DONT_EMAIL_OPEN: "DONT_TRACK_EMAIL_OPEN",
  DONT_LINK_CLICK: "DONT_TRACK_LINK_CLICK",
};

/** Fields safe to echo from GET /settings back onto POST. */
const SETTINGS_WRITE_KEYS = [
  "track_settings",
  "stop_lead_settings",
  "unsubscribe_text",
  "send_as_plain_text",
  "follow_up_percentage",
  "enable_ai_esp_matching",
  "bounce_autopause_threshold",
  "out_of_office_detection_settings",
  "ignoreOOOasReply",
  "autoReactivateOOO",
  "reactivateOOOwithDelay",
  "ai_categorisation_options",
] as const;

export function isUnder1kCampaign(name: string): boolean {
  return UNDER_1K.test(name) && !OVER_1K.test(name);
}

export function isOver1kCampaign(name: string): boolean {
  return OVER_1K.test(name);
}

export function isGoliathCampaign(name: string): boolean {
  return /goliath/i.test(name);
}

/** D80 — Smartlead autopause stays off. Name bands are not a write rule. */
export function desiredBounceAutopausePercent(_name?: string): number {
  return 100;
}

export function unwrapCampaignSettings(settings: unknown): Record<string, unknown> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return {};
  }
  const row = settings as Record<string, unknown>;
  if (row.data && typeof row.data === "object" && !Array.isArray(row.data)) {
    return unwrapCampaignSettings(row.data);
  }
  if (
    row.settings &&
    typeof row.settings === "object" &&
    !Array.isArray(row.settings)
  ) {
    return unwrapCampaignSettings(row.settings);
  }
  return row;
}

export function readBounceAutopausePercent(settings: unknown): number | null {
  const row = unwrapCampaignSettings(settings);
  const raw = row.bounce_autopause_threshold ?? row.bounceAutopauseThreshold;
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export function sanitizeTrackSettings(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return values.map((value) => {
    const key = String(value);
    return TRACK_REWRITE[key] ?? key;
  });
}

export function campaignSettingsWriteBody(
  current: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const src = unwrapCampaignSettings(current);
  const body: Record<string, unknown> = {};
  for (const key of SETTINGS_WRITE_KEYS) {
    if (src[key] === undefined) continue;
    body[key] = src[key];
  }
  const tracks = sanitizeTrackSettings(body.track_settings);
  if (tracks) body.track_settings = tracks;
  return { ...body, ...patch };
}
