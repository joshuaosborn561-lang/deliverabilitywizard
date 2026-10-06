import type { AppConfig } from "../config.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SmartleadCampaign } from "../types/index.js";
import { hasPoolMarkerTag } from "../lib/markerClients.js";
import { sleep } from "../lib/http.js";
import {
  isPocEngagementClient,
  pocEngagementClientIds,
} from "../lib/pocClient.js";
import type { StateStore } from "../state/store.js";
import { dropMembership, fetchInventory, type InventorySnapshot } from "./inventory.js";
import {
  syncGenericSeatsFromInventory,
  validateGenericPool,
  type GenericPoolSyncAccount,
} from "../lib/genericPoolCanon.js";
import { keepAssignedGenericForPodInventory } from "../lib/podInventory.js";
import { returnGenericToUntaggedPool } from "../lib/genericReturn.js";
import { returnSurplusGenerics } from "./genericSurplusReturn.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 200;

export interface GenericCleanupResult {
  dryRun: boolean;
  skipped?: boolean;
  reason?: string;
  examined: number;
  cleared: Array<{ email: string; clientId: number }>;
  returned: Array<{ email: string; clientId: number }>;
  errors: string[];
}

function campaignIsActive(campaign: { status?: string | null } | undefined): boolean {
  const status = String(campaign?.status ?? "").toUpperCase();
  return status === "ACTIVE" || status === "START";
}

/**
 * D205 / D228 / D236 — a GENERIC-tagged mailbox keeps a client's
 * client_id + signature while it sits on that client's ACTIVE
 * campaign, **or** while it is assigned to a POD that still needs
 * it for the 40/40 inventory (off-week: no campaign links). Surplus
 * in THAT POD still returns. A `POC`-tagged seat reserved to an
 * active engagement POC survives DRAFTED or ACTIVE and only
 * returns when that POC is marked done. Named seats are never
 * rewritten. PowerGRYD is a full client (D237).
 */
export class GenericCleanupService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: { dryRun?: boolean; inventory?: InventorySnapshot; now?: Date } = {},
  ): Promise<GenericCleanupResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const now = opts.now ?? new Date();
    const result: GenericCleanupResult = {
      dryRun,
      examined: 0,
      cleared: [],
      returned: [],
      errors: [],
    };
    if (!this.config.enableGenericCleanup) {
      return { ...result, skipped: true, reason: "disabled" };
    }

    const inventory = opts.inventory ?? (await fetchInventory(this.smartlead));
    const { campaigns, accounts, clients = [] } = inventory;
    const campaignById = new Map(
      (campaigns as SmartleadCampaign[]).map((c) => [c.id, c]),
    );
    const clientsById = new Map(clients.map((c) => [c.id, c]));
    const endedIds = this.state.listEndedPocClientIds();
    const pocIds = pocEngagementClientIds(
      clients,
      this.config.pocClientNamePatterns,
      endedIds,
    );
    const powerId = this.config.powerGrydClientId;
    const synced = syncGenericSeatsFromInventory({
      existing: this.state.listGenericSeats(),
      accounts: accounts as GenericPoolSyncAccount[],
      campaigns: campaigns as SmartleadCampaign[],
      config: this.config,
      state: this.state,
      now,
      powerGrydClientId: powerId,
      pocEngagementClientIds: pocIds,
    });
    const idleEmails = validateGenericPool({
      seats: synced.seats,
      namedStaffableByClientPod: synced.namedStaffableByClientPod,
      clientHasActiveCampaign: synced.clientHasActiveCampaign,
      campaignClientById: synced.campaignClientById,
      liveClientIdsByEmail: synced.liveClientIdsByEmail,
      powerGrydClientId: powerId,
      pocEngagementClientIds: pocIds,
    })
      .filter((row) => row.kind === "generic_idle")
      .map((row) => row.email);

    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;
      if (!hasPoolMarkerTag(account)) continue;
      result.examined += 1;
      const clientId =
        typeof account.client_id === "number" ? account.client_id : null;
      if (clientId == null) continue;

      const client = clientsById.get(clientId);
      const engagement = isPocEngagementClient({
        clientId,
        hay: client ? clientDisplayName(client) : "",
        name: client?.name,
        logo: client?.logo,
        patterns: this.config.pocClientNamePatterns,
        endedIds,
      });
      if (engagement) continue;

      const stillSendingForClient = campaignIdsOf(account).some((id) => {
        const campaign = campaignById.get(id);
        if (!campaign) return false;
        if (campaign.client_id !== clientId) return false;
        return campaignIsActive(campaign);
      });
      if (stillSendingForClient) continue;
      if (
        keepAssignedGenericForPodInventory({
          email,
          tags: account.tags,
          idleEmails,
        })
      ) {
        continue;
      }

      try {
        if (!dryRun) {
          for (const campaignId of campaignIdsOf(account)) {
            await this.smartlead.removeEmailAccountsFromCampaign(campaignId, [
              account.id,
            ]);
            dropMembership(account, campaignId);
            await sleep(WRITE_GAP_MS);
          }
          const cleared = await returnGenericToUntaggedPool({
            smartlead: this.smartlead,
            state: this.state,
            account,
            email,
            reason: "cleanup",
            now,
          });
          if (!cleared.ok) {
            result.errors.push(`${email}: return refused (${cleared.reason})`);
            continue;
          }
        }
        result.cleared.push({ email, clientId });
        console.log(
          `[generic-cleanup] returned ${email} from client ${clientId} (client_id, signature, POD tag cleared)`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${email}: ${message}`);
      }
    }

    const surplus = await returnSurplusGenerics({
      config: this.config,
      smartlead: this.smartlead,
      state: this.state,
      inventory: { campaigns, accounts, clients, fetchedAt: 0, ...opts.inventory },
      dryRun,
      now,
    });
    result.returned.push(...surplus.returned);
    result.errors.push(...surplus.errors);

    console.log(
      `[generic-cleanup] examined=${result.examined} cleared=${result.cleared.length} returned=${result.returned.length} errors=${result.errors.length}`,
    );
    if (!dryRun) await this.state.save();
    return result;
  }
}
