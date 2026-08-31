/**
 * Smartlead campaign settings helpers.
 *
 * D157 — Smartlead's High Bounce Rate Auto Protection is UI-only. POST
 * /campaigns/{id}/settings schema-validates `bounce_autopause_threshold`
 * ("must be a string"; unknown keys 400) and the handler then DISCARDS
 * it — a "banana" write returns ok:true and the UI keeps its value
 * (proven live 2026-08-31; a Peterson campaign still showed 7% after
 * fleet-wide "100" and null writes that all returned ok). There is no
 * GET for it either. Never write or read that field from here: the
 * off-switch is the campaign SETUP page in the UI, and the pause
 * attribution surface is `campaign_activity_logs.paused_reason:
 * "bounce protection"` on GET /campaigns. The name-band helpers stay
 * deleted (D129) — campaign names never pick a bounce threshold.
 */

const TRACK_REWRITE: Record<string, string> = {
  DONT_EMAIL_OPEN: "DONT_TRACK_EMAIL_OPEN",
  DONT_LINK_CLICK: "DONT_TRACK_LINK_CLICK",
};

/**
 * Fields safe to echo from GET /settings back onto POST.
 * `bounce_autopause_threshold` is deliberately absent — the handler
 * discards it (D157), so echoing it only implies a control we don't have.
 */
const SETTINGS_WRITE_KEYS = [
  "track_settings",
  "stop_lead_settings",
  "unsubscribe_text",
  "send_as_plain_text",
  "follow_up_percentage",
  "enable_ai_esp_matching",
  "out_of_office_detection_settings",
  "ignoreOOOasReply",
  "autoReactivateOOO",
  "reactivateOOOwithDelay",
  "ai_categorisation_options",
] as const;

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
