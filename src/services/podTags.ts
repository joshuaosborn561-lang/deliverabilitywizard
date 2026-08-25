import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { chunkArray, sleep } from "../lib/http.js";
import { isGenericMailbox } from "../lib/clientInbox.js";
import { isRetiredSendingDomain } from "../lib/domainControl.js";
import { isIsolationEmail, normalizeIsolationDomain } from "../lib/isolationDomain.js";
import {
  isPodTagName,
  POD_A_TAG,
  POD_B_TAG,
  POD_TAG_COLOR,
  podTagFromAccount,
  podTagName,
} from "../lib/podTags.js";
import {
  onWeekCohort,
  resolveClientCohorts,
  type RestCohort,
} from "../lib/restCohort.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign } from "../types/index.js";
import { clientRestGroupKey } from "./clientRest.js";

const TAG_BATCH = 25;

/**
 * D68 — stamp every client mailbox with POD-A or POD-B so agents staffing
 * a new campaign can see which rest pool it is on. Generics are ignored
 * (and stripped if they picked up a pod tag).
 */

export interface PodTagResult {
  dryRun: boolean;
  scanned: number;
  taggedA: number;
  taggedB: number;
  alreadySet: number;
  updated: number;
  strippedGeneric: number;
  errors: string[];
}

export class PodTagService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<PodTagResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: PodTagResult = {
      dryRun,
      scanned: 0,
      taggedA: 0,
      taggedB: 0,
      alreadySet: 0,
      updated: 0,
      strippedGeneric: 0,
      errors: [],
    };
    if (!this.config.enablePodTagConverge) {
      console.log("[pod-tags] Disabled (ENABLE_POD_TAG_CONVERGE=false)");
      return result;
    }

    const [campaigns, accounts, tags] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      this.smartlead.listTags(),
    ]);
    result.scanned = accounts.length;

    const tagIdByName = new Map(
      tags.map((tag) => [tag.name.trim().toUpperCase(), tag.id]),
    );
    const ensure = async (name: string, color: string): Promise<number> => {
      const have = tagIdByName.get(name.toUpperCase());
      if (have) return have;
      if (dryRun) return -1;
      const created = await this.smartlead.ensureTag(name, color);
      tagIdByName.set(created.name.trim().toUpperCase(), created.id);
      return created.id;
    };
    const tagA = await ensure(POD_A_TAG, POD_TAG_COLOR.A);
    const tagB = await ensure(POD_B_TAG, POD_TAG_COLOR.B);
    const podTagIds = new Set(
      tags.filter((tag) => isPodTagName(tag.name)).map((tag) => tag.id),
    );
    if (tagA > 0) podTagIds.add(tagA);
    if (tagB > 0) podTagIds.add(tagB);

    const campaignClientById = new Map(
      (campaigns as SmartleadCampaign[]).map((campaign) => [
        campaign.id,
        campaign.client_id,
      ]),
    );

    const isolation = {
      emails: new Set(this.config.isolationMailboxEmails),
      domain: normalizeIsolationDomain(this.config.isolationDomain),
    };

    const assignA: number[] = [];
    const assignB: number[] = [];
    const strip: number[] = [];

    const candidates: Array<{
      account: SmartleadAccountWithCampaigns;
      email: string;
      groupKey: string;
    }> = [];
    const byGroup = new Map<
      string,
      Array<{ email: string; tagged: RestCohort | null }>
    >();

    for (const account of accounts as SmartleadAccountWithCampaigns[]) {
      const email = accountEmail(account);
      if (!email || !account.id) continue;
      if (isIsolationEmail(email, isolation)) continue;
      if (this.state.isCopyCanary(email)) continue;

      const existing = podTagFromAccount(account);
      const generic = isGenericMailbox(account, email, this.config, this.state);
      if (generic) {
        if (existing) {
          strip.push(account.id);
          result.strippedGeneric += 1;
        }
        continue;
      }

      const domain = email.split("@")[1]?.toLowerCase();
      if (isRetiredSendingDomain(domain, this.state.getDomainHistory(domain))) {
        continue;
      }

      const groupKey = clientRestGroupKey(account, email, campaignClientById);
      if (!groupKey) continue;

      candidates.push({ account, email, groupKey });
      const list = byGroup.get(groupKey) ?? [];
      list.push({ email, tagged: existing });
      byGroup.set(groupKey, list);
    }

    const cohortByEmail = new Map<string, RestCohort>();
    for (const [, rows] of byGroup) {
      for (const [email, cohort] of resolveClientCohorts(rows)) {
        cohortByEmail.set(email, cohort);
      }
    }

    for (const { account, email } of candidates) {
      const desired = cohortByEmail.get(email);
      if (!desired) continue;
      if (desired === "A") result.taggedA += 1;
      else result.taggedB += 1;

      const have = podTagFromAccount(account);
      if (have === desired) {
        result.alreadySet += 1;
        continue;
      }
      if (have) strip.push(account.id);
      if (desired === "A") assignA.push(account.id);
      else assignB.push(account.id);
      result.updated += 1;
    }

    if (!dryRun) {
      try {
        await this.flushRemovals(strip, [...podTagIds]);
        await this.flushAssign(assignA, tagA);
        await this.flushAssign(assignB, tagB);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(message);
        console.warn("[pod-tags] write failed", error);
      }
    }

    console.log(
      `[pod-tags] on-week=${podTagName(onWeekCohort())} scanned=${result.scanned} A=${result.taggedA} B=${result.taggedB} already=${result.alreadySet} updated=${result.updated} strippedGeneric=${result.strippedGeneric}`,
    );
    return result;
  }

  private async flushRemovals(accountIds: number[], tagIds: number[]): Promise<void> {
    if (!accountIds.length || !tagIds.length) return;
    for (const batch of chunkArray([...new Set(accountIds)], TAG_BATCH)) {
      await this.smartlead.removeTags(batch, tagIds);
      await sleep(350);
    }
  }

  private async flushAssign(accountIds: number[], tagId: number): Promise<void> {
    if (!accountIds.length || tagId <= 0) return;
    for (const batch of chunkArray([...new Set(accountIds)], TAG_BATCH)) {
      await this.smartlead.assignTags(batch, [tagId]);
      await sleep(350);
    }
  }
}
