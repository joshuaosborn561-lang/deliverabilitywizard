import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { hasPocReservationTag, hasPoolMarkerTag } from "../lib/markerClients.js";
import {
  GENERIC_ASSIGN_REASON_POC_ENGAGEMENT,
} from "../lib/genericPool.js";
import { returnGenericToUntaggedPool } from "../lib/genericReturn.js";
import { GOLIATH_CLIENT_ID, isPocClient, pocClientHay } from "../lib/pocClient.js";
import { sleep } from "../lib/http.js";
import type { StateStore } from "../state/store.js";
import { dropMembership, fetchInventory, type InventorySnapshot } from "./inventory.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 200;

export interface EndPocResult {
  dryRun: boolean;
  clientId: number | null;
  marked: boolean;
  released: Array<{ email: string; clientId: number }>;
  errors: string[];
  reason?: string;
}

/**
 * D236 — mark a name-list POC done and release its reserved seats
 * (clear client_id, signature, POD, POC tag; keep GENERIC).
 */
export class EndPocService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly state: StateStore,
  ) {}

  async run(
    opts: {
      clientId?: number | null;
      dryRun?: boolean;
      inventory?: InventorySnapshot;
      now?: Date;
    } = {},
  ): Promise<EndPocResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const now = opts.now ?? new Date();
    const result: EndPocResult = {
      dryRun,
      clientId: null,
      marked: false,
      released: [],
      errors: [],
    };
    const inventory = opts.inventory ?? (await fetchInventory(this.smartlead));
    const clientId = resolveEndPocClientId(
      opts.clientId,
      inventory.clients,
      this.config.pocClientNamePatterns,
    );
    if (clientId == null) {
      return { ...result, reason: "missing_client" };
    }
    result.clientId = clientId;
    if (!dryRun) this.state.markPocEnded(clientId);
    result.marked = true;

    for (const account of inventory.accounts as SmartleadAccountWithCampaigns[]) {
      if (account.client_id !== clientId) continue;
      const email = accountEmail(account);
      if (!email || typeof account.id !== "number") continue;
      const seat = this.state.getGenericSeat(email);
      const reserved =
        hasPocReservationTag(account) ||
        hasPoolMarkerTag(account) ||
        seat?.reason === GENERIC_ASSIGN_REASON_POC_ENGAGEMENT ||
        seat?.assignedClientId === clientId;
      if (!reserved) continue;
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
            reason: "end_poc",
            now,
          });
          if (!cleared.ok) {
            result.errors.push(`${email}: return refused (${cleared.reason})`);
            continue;
          }
        }
        result.released.push({ email, clientId });
        console.log(`[end-poc] released ${email} from client ${clientId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${email}: ${message}`);
      }
    }
    if (!dryRun) await this.state.save();
    console.log(
      `[end-poc] client=${clientId} released=${result.released.length} errors=${result.errors.length}`,
    );
    return result;
  }
}

export function resolveEndPocClientId(
  clientId: number | null | undefined,
  clients: Array<{ id: number; name?: string | null; logo?: string | null }>,
  patterns: string[],
): number | null {
  if (typeof clientId === "number" && clientId > 0) return clientId;
  for (const client of clients) {
    if (isPocClient(pocClientHay(client), patterns) && client.id !== GOLIATH_CLIENT_ID) {
      return client.id;
    }
  }
  return null;
}

export function endPocClientLabel(
  clients: Array<{ id: number; name?: string | null; logo?: string | null }>,
  clientId: number,
): string {
  const client = clients.find((row) => row.id === clientId);
  return client ? clientDisplayName(client) : String(clientId);
}
