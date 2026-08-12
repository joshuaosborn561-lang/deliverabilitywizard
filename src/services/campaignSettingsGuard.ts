import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type {
  SmartleadClient,
  SmartleadClientRecord,
} from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import { matchClientForCampaign } from "../lib/campaignClientMatch.js";
import type { SmartleadCampaign } from "../types/index.js";

/**
 * Standing campaign settings (Josh):
 * - Every campaign has a Smartlead client_id
 * - Bounce auto-pause at 5%
 * - AI categorize: Interested, Not Interested, Out Of Office
 * - OOO auto-categorize on
 *
 * Smartlead GET campaign often omits bounce/OOO/category fields, so this
 * guard converges by writing the desired payload every monitor pass
 * (idempotent). Client assignment is read from listCampaigns.
 */

/** Tenant-stable category ids from GET leads/fetch-categories. */
export const DEFAULT_AI_CATEGORY_IDS = {
  interested: 1,
  notInterested: 3,
  outOfOffice: 6,
} as const;

export const DESIRED_AI_CATEGORY_IDS = [
  DEFAULT_AI_CATEGORY_IDS.interested,
  DEFAULT_AI_CATEGORY_IDS.notInterested,
  DEFAULT_AI_CATEGORY_IDS.outOfOffice,
];

export interface CampaignSettingsGuardResult {
  dryRun: boolean;
  scanned: number;
  settingsApplied: number;
  clientsAssigned: number;
  clientsMissing: Array<{ campaignId: number; name: string; status: string }>;
  errors: string[];
}

function desiredSettingsPayload(config: AppConfig, clientId?: number | null) {
  const body: {
    bounce_autopause_threshold: string;
    ai_categorisation_options: number[];
    out_of_office_detection_settings: {
      ignoreOOOasReply: boolean;
      autoReactivateOOO: boolean;
      reactivateOOOwithDelay: number;
      autoCategorizeOOO: boolean;
    };
    client_id?: number;
  } = {
    bounce_autopause_threshold: String(config.campaignBounceAutopauseThreshold),
    ai_categorisation_options: [...DESIRED_AI_CATEGORY_IDS],
    out_of_office_detection_settings: {
      ignoreOOOasReply: false,
      autoReactivateOOO: false,
      reactivateOOOwithDelay: 0,
      autoCategorizeOOO: true,
    },
  };
  if (typeof clientId === "number" && clientId > 0) {
    body.client_id = clientId;
  }
  return body;
}

export class CampaignSettingsGuardService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<CampaignSettingsGuardResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: CampaignSettingsGuardResult = {
      dryRun,
      scanned: 0,
      settingsApplied: 0,
      clientsAssigned: 0,
      clientsMissing: [],
      errors: [],
    };

    if (!this.config.enableCampaignSettingsGuard) {
      console.log(
        "[campaign-settings] Disabled (ENABLE_CAMPAIGN_SETTINGS_GUARD=false)",
      );
      return result;
    }

    const statuses = new Set(
      this.config.campaignSettingsGuardStatuses.map((s) => s.toUpperCase()),
    );

    let campaigns: SmartleadCampaign[] = [];
    let clients: SmartleadClientRecord[] = [];
    try {
      [campaigns, clients] = await Promise.all([
        this.smartlead.listCampaigns(),
        this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`inventory: ${message}`);
      return result;
    }

    const targets = campaigns.filter((c) =>
      statuses.has(String(c.status ?? "").toUpperCase()),
    );
    result.scanned = targets.length;
    console.log(
      `[campaign-settings] Converging ${targets.length} campaigns (${dryRun ? "DRY RUN" : "LIVE"})`,
    );

    const missingForSlack: CampaignSettingsGuardResult["clientsMissing"] = [];

    for (const campaign of targets) {
      try {
        let clientId =
          typeof campaign.client_id === "number" && campaign.client_id > 0
            ? campaign.client_id
            : null;

        if (clientId == null) {
          const matched = matchClientForCampaign(campaign, clients, campaigns);
          if (matched) {
            clientId = matched.clientId;
            console.log(
              `[campaign-settings] #${campaign.id} assign client ${clientId} (${matched.reason})`,
            );
            if (!dryRun) {
              await this.smartlead.updateCampaignSettings(campaign.id, {
                client_id: clientId,
              });
              result.clientsAssigned += 1;
              await sleep(120);
            } else {
              result.clientsAssigned += 1;
            }
          } else {
            const row = {
              campaignId: campaign.id,
              name: campaign.name || `Campaign ${campaign.id}`,
              status: String(campaign.status ?? ""),
            };
            result.clientsMissing.push(row);
            if (/^(ACTIVE|PAUSED|DRAFTED)$/i.test(row.status)) {
              missingForSlack.push(row);
            }
          }
        }

        const payload = desiredSettingsPayload(this.config, clientId);
        if (!dryRun) {
          await this.smartlead.updateCampaignSettings(campaign.id, payload);
          await sleep(120);
        }
        result.settingsApplied += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id}: ${message}`);
      }
    }

    if (missingForSlack.length) {
      try {
        await this.slack.send(
          [
            "*Campaigns missing a Smartlead client*",
            "Every campaign must have a client assigned. I could not match these automatically — create/assign the client in Smartlead:",
            ...missingForSlack.map(
              (c) => `• #${c.campaignId} [${c.status}] ${c.name}`,
            ),
          ].join("\n"),
        );
      } catch (error) {
        console.warn("[campaign-settings] Slack missing-client alert failed", error);
      }
    }

    console.log("[campaign-settings] Done", {
      scanned: result.scanned,
      settingsApplied: result.settingsApplied,
      clientsAssigned: result.clientsAssigned,
      clientsMissing: result.clientsMissing.length,
      errors: result.errors.length,
    });
    return result;
  }
}
