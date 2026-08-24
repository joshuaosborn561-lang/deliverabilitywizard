import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  campaignIdOf,
  normalizeTestList,
  testIdOf,
  type SmartDeliveryClient,
} from "../clients/smartdelivery.js";
import { sleep } from "../lib/http.js";
import {
  formatInfraMessage,
  parseSendingInfra,
  summarizeSendingInfra,
  type InfraVerdict,
} from "../lib/sendingInfra.js";
import type { StateStore } from "../state/store.js";

const WEEK_MS = 7 * 86_400_000;

export interface SendingInfraResult {
  verdict: InfraVerdict;
  testsRead: number;
  ips: number;
  posted: boolean;
  errors: string[];
}

/**
 * D53 — one census of sending IPs from placement reports we already run.
 * Does not buy anything. Does not change mailboxes.
 */
export class SendingInfraService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(): Promise<SendingInfraResult> {
    const result: SendingInfraResult = {
      verdict: "unknown",
      testsRead: 0,
      ips: 0,
      posted: false,
      errors: [],
    };
    if (!this.config.enableSendingInfraCensus) {
      console.log("[sending-infra] Disabled");
      return result;
    }

    let tests;
    try {
      tests = normalizeTestList(await this.smartDelivery.listTests({}));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`list tests: ${message}`);
      return result;
    }

    const latestByCampaign = new Map<string, (typeof tests)[number]>();
    const extras: typeof tests = [];
    for (const test of [...tests].sort((a, b) =>
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
    )) {
      const campaign = campaignIdOf(test);
      const id = testIdOf(test);
      if (!id) continue;
      if (campaign) {
        if (!latestByCampaign.has(campaign)) latestByCampaign.set(campaign, test);
      } else if (extras.length < 4) {
        extras.push(test);
      }
    }
    const chosen = [...latestByCampaign.values(), ...extras].slice(0, 16);

    const rows = [];
    for (const test of chosen) {
      const testId = testIdOf(test);
      if (!testId) continue;
      try {
        const [analytics, rdns, blacklist] = await Promise.all([
          this.smartDelivery.getIpAnalytics(testId).catch(() => null),
          this.smartDelivery.getRdnsDetails(testId).catch(() => null),
          this.smartDelivery.getIpBlacklist(testId).catch(() => null),
        ]);
        rows.push(...parseSendingInfra({ analytics, rdns, blacklist }));
        result.testsRead += 1;
        await sleep(120);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`test ${testId}: ${message}`);
      }
    }

    const unique = new Map(rows.map((row) => [row.ip, row]));
    const summary = summarizeSendingInfra([...unique.values()]);
    result.verdict = summary.verdict;
    result.ips = summary.rows.length;

    const key = `sending-infra:v1:${summary.verdict}`;
    const already = this.state.hasRecentAlert(key, WEEK_MS);
    const firstLook = !this.state.hasAlert("sending-infra:v1:posted");
    const shouldPost =
      firstLook ||
      summary.verdict === "bad" ||
      (summary.verdict === "mixed" && !already) ||
      (summary.verdict === "good" && firstLook);

    if (shouldPost && !already) {
      await this.slack.notifySendingInfra({ text: formatInfraMessage(summary) });
      this.state.markAlert(key);
      this.state.markAlert("sending-infra:v1:posted");
      result.posted = true;
    }

    console.log("[sending-infra]", {
      verdict: summary.verdict,
      ips: summary.rows.length,
      tests: result.testsRead,
      posted: result.posted,
    });
    await this.state.save();
    return result;
  }
}
