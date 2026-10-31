/**
 * D321 — placeholder-name sweep (LOCKED rule "Every inbox has a name").
 *
 * Josh, 2026-10-29: "Every inbox has a name. Canon that it can never have
 * that again. If no name just send as the company. But everyone should
 * have a name."
 *
 * Finds every mailbox on a non-STOPPED campaign whose from_name (or the
 * name line of its signature) is blank or a placeholder ("Pool User",
 * one word, generic, test, the email local part, ...) and REPLACES it:
 * the seat's persona from the Generics Ledger / InboxKit pool row if it
 * has one, otherwise the client company name (from_name = company,
 * signature = company). It never unlinks, never changes a campaign status,
 * and never touches copy or leads.
 *
 * Reads the shared account book (no extra fleet fetch). The write is
 * behind PLACEHOLDER_SWEEP_WRITE_ENABLED, default OFF: with it off the
 * sweep only counts and logs what it WOULD change.
 */
import {
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
  type SmartleadAccountWithCampaigns,
  type SmartleadClient,
} from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import type { AppConfig } from "../config.js";
import { isGabeVmReserved } from "../lib/canaryLock.js";
import { brandFromClientDisplayName } from "../lib/clientBrand.js";
import { isInsightCampaignId } from "../lib/insightCampaigns.js";
import { sleep } from "../lib/http.js";
import { extractSignatureLines } from "../lib/mailboxSignature.js";
import {
  isCompanySenderName,
  isPlaceholderPersonName,
  resolveSendIdentity,
} from "../lib/personaName.js";
import type { StateStore } from "../state/store.js";
import type { InventorySnapshot } from "./inventory.js";

/** Writes per sweep, so a 299-seat backlog drains over a few runs (Smartlead limiter). */
export const PLACEHOLDER_SWEEP_MAX_WRITES = 60;
const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 250;

export interface PlaceholderSweepRow {
  email: string;
  accountId: number;
  clientId: number | null;
  brand: string;
  was: { fromName: string; signature: string };
  to: { fromName: string; signature: string; source: string };
}

export interface PlaceholderSweepResult {
  examined: number;
  /** Seats found with a blank / placeholder sender name on a live campaign. */
  placeholders: number;
  /** Seats whose from_name/signature were rewritten (0 while the write flag is off). */
  replaced: number;
  /** Seats that would be rewritten but the write flag is OFF or the per-run cap hit. */
  pending: number;
  /** Seats skipped: Gabe VM, canary, Insight, no resolvable client/company name. */
  skipped: number;
  writeEnabled: boolean;
  rows: PlaceholderSweepRow[];
  errors: string[];
}

function signatureNameLine(signature?: string | null): string {
  return extractSignatureLines(signature)[0] ?? "";
}

export class PlaceholderSweepService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: Pick<SmartleadClient, "updateEmailAccount">,
    private readonly state: Pick<StateStore, "getPoolMailbox" | "isCopyCanary">,
    private readonly slack?: Pick<SlackClient, "notifyDeliverabilityNote">,
  ) {}

  async run(input: {
    inventory: InventorySnapshot;
    /** Test hook; production uses config.placeholderSweepWriteEnabled. */
    writeEnabled?: boolean;
    signal?: AbortSignal;
  }): Promise<PlaceholderSweepResult> {
    const writeEnabled =
      input.writeEnabled ?? this.config.placeholderSweepWriteEnabled === true;
    const { accounts, campaigns, clients } = input.inventory;
    const result: PlaceholderSweepResult = {
      examined: 0,
      placeholders: 0,
      replaced: 0,
      pending: 0,
      skipped: 0,
      writeEnabled,
      rows: [],
      errors: [],
    };
    const campaignById = new Map(campaigns.map((c) => [c.id, c]));
    const clientById = new Map(clients.map((c) => [c.id, c]));
    let writes = 0;

    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      if (input.signal?.aborted) break;
      const email = accountEmail(account)?.toLowerCase();
      if (!email || typeof account.id !== "number") continue;
      const live = campaignIdsOf(account).filter((id) => {
        const status = String(campaignById.get(id)?.status ?? "").toUpperCase();
        return campaignById.has(id) && status !== "STOPPED";
      });
      if (!live.length) continue;
      result.examined += 1;

      if (
        isGabeVmReserved(account) ||
        this.state.isCopyCanary(email) ||
        live.some((id) => isInsightCampaignId(id))
      ) {
        result.skipped += 1;
        continue;
      }

      // The company the seat sends for: its client_id, else the one client
      // all its live campaigns belong to.
      let clientId: number | null =
        typeof account.client_id === "number" ? account.client_id : null;
      if (clientId == null) {
        const owners = new Set(
          live
            .map((id) => campaignById.get(id)?.client_id)
            .filter((v): v is number => typeof v === "number"),
        );
        if (owners.size === 1) clientId = [...owners][0]!;
      }
      const client = clientId != null ? clientById.get(clientId) : undefined;
      const brand = client
        ? brandFromClientDisplayName(clientDisplayName(client))
        : "";

      const fromName = (account.from_name ?? "").trim();
      const sigName = signatureNameLine(account.signature);
      const nameBad =
        isPlaceholderPersonName(fromName, email) &&
        !isCompanySenderName(fromName, brand);
      const sigBad =
        Boolean(sigName) &&
        isPlaceholderPersonName(sigName, email) &&
        !isCompanySenderName(sigName, brand);
      if (!nameBad && !sigBad) continue;
      result.placeholders += 1;

      const identity = resolveSendIdentity({
        email,
        pool: this.state.getPoolMailbox(email),
        // The live name is the placeholder; only a real one could be reused.
        liveFromName: nameBad ? null : fromName,
        clientBrand: brand,
      });
      if (!identity) {
        result.skipped += 1;
        result.errors.push(`${email}: no persona and no company name (client ${clientId ?? "none"})`);
        continue;
      }
      const row: PlaceholderSweepRow = {
        email,
        accountId: account.id,
        clientId,
        brand,
        was: { fromName, signature: account.signature ?? "" },
        to: {
          fromName: identity.fromName,
          signature: identity.signature,
          source: identity.source,
        },
      };

      if (!writeEnabled || writes >= PLACEHOLDER_SWEEP_MAX_WRITES) {
        result.pending += 1;
        result.rows.push(row);
        continue;
      }
      try {
        // Name + signature only. No unlink, no status, no copy, no leads.
        await this.smartlead.updateEmailAccount(account.id, {
          from_name: identity.fromName,
          signature: identity.signature,
        });
        writes += 1;
        result.replaced += 1;
        result.rows.push(row);
        await sleep(WRITE_GAP_MS);
      } catch (error) {
        result.errors.push(
          `${email}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    console.log(
      `[placeholder-sweep] examined=${result.examined} placeholders=${result.placeholders} replaced=${result.replaced} pending=${result.pending} skipped=${result.skipped} errors=${result.errors.length} write=${writeEnabled}`,
    );
    if (result.replaced > 0 && this.slack) {
      const byClient = new Map<string, number>();
      for (const row of result.rows) {
        const key = row.brand || `client ${row.clientId ?? "?"}`;
        byClient.set(key, (byClient.get(key) ?? 0) + 1);
      }
      const company = result.rows.filter((r) => r.to.source === "company").length;
      try {
        await this.slack.notifyDeliverabilityNote(
          [
            `*Placeholder sender names replaced* — ${result.replaced} seat${result.replaced === 1 ? "" : "s"} (${result.pending} still to do).`,
            `${result.replaced - company} got their persona back, ${company} now send as the company.`,
            [...byClient].map(([k, n]) => `${k}: ${n}`).join(" · "),
          ].join("\n"),
        );
      } catch (error) {
        result.errors.push(
          `slack: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  }
}
