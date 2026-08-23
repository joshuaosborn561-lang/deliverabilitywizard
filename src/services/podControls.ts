import type { AppConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import {
  accountEmail,
  campaignIdsOf,
  pickSequence,
  resolveAccountClient,
  sequenceMappingIdOf,
  type SmartleadClient,
} from "../clients/smartlead.js";
import {
  folderIdOf,
  parseSenderInboxRates,
  type SmartDeliveryClient,
} from "../clients/smartdelivery.js";
import { chunkArray, sleep } from "../lib/http.js";
import { defaultControlTemplate } from "../lib/controlTemplate.js";
import {
  POD_CONTROL_FOLDER_NAME,
  podControlTestName,
} from "../lib/isolationNames.js";
import {
  controlSequence,
  isolationManualPayload,
  isolationSchedulePayload,
} from "../lib/isolationPlacement.js";
import { isIsolationEmail, normalizeIsolationDomain } from "../lib/isolationDomain.js";
import { buildPods, emailsForPod, type Pod } from "../lib/pods.js";
import {
  placementFromInboxRate,
  podVerdictFromSenders,
  rollingFailCount,
  tagFromPlacements,
} from "../lib/mailboxControlTag.js";
import {
  OPEN_ENDED_TEST_DAYS,
  addDaysIso,
  paddedScheduleDate,
  schedulerCronValue,
} from "./campaignScanner.js";
import type { StateStore } from "../state/store.js";
import type { IsolationPodRecord } from "../state/isolationState.js";

export interface PodControlResult {
  dryRun: boolean;
  pods: number;
  testsCreated: string[];
  sendersRead: number;
  kill: number;
  watch: number;
  errors: string[];
}

export class PodControlService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly smartDelivery: SmartDeliveryClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<PodControlResult> {
    const dryRun = opts.dryRun ?? this.config.dryRun;
    const result: PodControlResult = {
      dryRun,
      pods: 0,
      testsCreated: [],
      sendersRead: 0,
      kill: 0,
      watch: 0,
      errors: [],
    };

    if (!this.config.enablePodControls) {
      console.log("[pod-controls] Disabled");
      return result;
    }

    const template = defaultControlTemplate();
    const isolation = this.state.getIsolation();
    if (
      !isolation.controlTemplate ||
      isolation.controlTemplate.controlVersion !== template.controlVersion
    ) {
      this.state.patchIsolation({
        controlTemplate: {
          controlVersion: template.controlVersion,
          subject: template.subject,
          bodyText: template.bodyText,
          createdAt: isolation.controlTemplate?.createdAt ?? new Date().toISOString(),
        },
      });
    }

    let pods: Pod[] = [];
    try {
      pods = await this.loadPods();
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      return result;
    }
    result.pods = pods.length;
    this.persistPods(pods);

    const folderId = await this.ensureFolder(POD_CONTROL_FOLDER_NAME, "podControls");
    const shellCampaignId = await this.shellCampaignId();
    const sequenceMappingId = await this.shellSequenceMappingId(shellCampaignId);
    if (sequenceMappingId == null) {
      result.errors.push(
        "shell campaign has no sequence_mapping_id — cannot schedule pod controls",
      );
      return result;
    }
    const providerIds = await this.resolveProviderIds();
    if (!providerIds.length) {
      result.errors.push(
        "no SmartDelivery provider_ids — cannot schedule pod controls",
      );
      return result;
    }
    const existingByPod = await this.indexExistingControls(pods);

    for (const pod of pods) {
      const emails = emailsForPod(pod);
      if (!emails.length) continue;
      const chunks = chunkArray(emails, this.config.maxMailboxesPerTest);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const key = `${pod.id}:${index}`;
        const existing = existingByPod.get(key);
        if (existing) continue;
        if (dryRun) {
          result.testsCreated.push(`dry-run:${key}`);
          continue;
        }
        try {
          const created = await this.createPodTest({
            pod,
            emails: chunk,
            chunk: index + 1,
            chunks: chunks.length,
            folderId,
            shellCampaignId,
            sequenceMappingId,
            providerIds,
            template,
          });
          this.state.upsertPodControl({
            id: key,
            podId: pod.id,
            controlVersion: template.controlVersion,
            spamTestId: created,
            folderId,
            emails: chunk,
            createdAt: new Date().toISOString(),
          });
          result.testsCreated.push(created);
        } catch (error) {
          result.errors.push(
            `create ${pod.id} ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await sleep(400);
      }
    }

    await this.readExisting(result);
    this.state.patchIsolation({ lastPodControlAt: new Date().toISOString() });
    await this.state.save();

    result.kill = this.state
      .listMailboxControls()
      .filter((row) => row.tag === "kill").length;
    result.watch = this.state
      .listMailboxControls()
      .filter((row) => row.tag === "watch").length;

    console.log("[pod-controls] Done", {
      pods: result.pods,
      created: result.testsCreated.length,
      sendersRead: result.sendersRead,
      kill: result.kill,
      watch: result.watch,
      errors: result.errors.length,
    });

    if (result.testsCreated.length || result.kill || result.errors.length) {
      await this.slack
        .notifyPodControls({
          pods: result.pods,
          testsCreated: result.testsCreated.length,
          sendersRead: result.sendersRead,
          kill: result.kill,
          watch: result.watch,
          errors: result.errors,
        })
        .catch(() => undefined);
    }
    return result;
  }

  private async loadPods(): Promise<Pod[]> {
    const [campaigns, accounts, clients] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listAllEmailAccounts({ fetchCampaigns: true }),
      this.smartlead.listClients().catch(() => []),
    ]);
    const active = new Set(
      campaigns
        .filter((campaign) => String(campaign.status ?? "").toUpperCase() === "ACTIVE")
        .map((campaign) => campaign.id),
    );
    const campaignClient = new Map(
      campaigns.map((campaign) => [campaign.id, campaign.client_id]),
    );
    const clientsById = new Map(clients.map((client) => [client.id, client]));
    const resting = new Set(
      this.state.listRestingInboxes().map((row) => row.email.toLowerCase()),
    );
    const isolation = {
      emails: new Set(this.config.isolationMailboxEmails),
      domain: normalizeIsolationDomain(this.config.isolationDomain),
    };

    return buildPods({
      config: this.config,
      state: this.state,
      isolation,
      accounts: accounts.flatMap((account) => {
        const email = accountEmail(account)?.toLowerCase();
        if (!email || isIsolationEmail(email, isolation)) return [];
        const ids = campaignIdsOf(account);
        const onActiveCampaign = ids.some((id) => active.has(id));
        const client = resolveAccountClient(account, campaignClient, clientsById);
        return [
          {
            accountId: account.id,
            email,
            clientId: client.clientId,
            clientName: client.clientName,
            fromName: account.from_name,
            onActiveCampaign,
            resting: resting.has(email),
          },
        ];
      }),
    });
  }

  private persistPods(pods: Pod[]): void {
    const records: Record<string, IsolationPodRecord> = {};
    const now = new Date().toISOString();
    for (const pod of pods) {
      records[pod.id] = {
        id: pod.id,
        name: pod.name,
        pool: pod.pool,
        status: pod.status,
        clientId: pod.clientId,
        mailboxIds: pod.mailboxes.map((mailbox) => mailbox.accountId),
        emails: pod.mailboxes.map((mailbox) => mailbox.email),
        updatedAt: now,
      };
    }
    this.state.patchIsolation({ pods: records });
  }

  private async indexExistingControls(
    pods: Pod[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const row of this.state.listPodControls()) {
      if (row.spamTestId) out.set(row.id, row.spamTestId);
    }
    try {
      const tests = await this.smartDelivery.listTests();
      for (const pod of pods) {
        const emails = emailsForPod(pod);
        if (!emails.length) continue;
        const chunks = chunkArray(emails, this.config.maxMailboxesPerTest);
        for (let index = 0; index < chunks.length; index += 1) {
          const key = `${pod.id}:${index}`;
          if (out.has(key)) continue;
          const wanted = podControlTestName(pod.name, index + 1, chunks.length);
          const found = tests.find((test) => {
            const name = String(test.test_name ?? "");
            if (name !== wanted) return false;
            const status = String(test.status ?? "").toLowerCase();
            return !/stop|complet|cancel|expir|fail|delet|finish|end/i.test(
              status,
            );
          });
          const id = found?.spam_test_id ?? found?.id;
          if (id == null) continue;
          out.set(key, String(id));
          if (!this.state.listPodControls().some((row) => row.id === key)) {
            this.state.upsertPodControl({
              id: key,
              podId: pod.id,
              controlVersion:
                this.state.getIsolation().controlTemplate?.controlVersion ??
                "imported",
              spamTestId: String(id),
              emails: chunks[index] ?? [],
              createdAt: new Date().toISOString(),
            });
          }
        }
      }
    } catch (error) {
      console.warn(
        "[pod-controls] existing-test index failed:",
        error instanceof Error ? error.message : error,
      );
    }
    return out;
  }

  private async createPodTest(input: {
    pod: Pod;
    emails: string[];
    chunk: number;
    chunks: number;
    folderId?: string | number;
    shellCampaignId?: number;
    sequenceMappingId: number;
    providerIds: number[];
    template: ReturnType<typeof defaultControlTemplate>;
  }): Promise<string> {
    const scheduledAt = paddedScheduleDate();
    const manual = isolationManualPayload({
      testName: podControlTestName(input.pod.name, input.chunk, input.chunks),
      description: [
        "Standing pod control — fixed control email, not campaign copy.",
        `Pod ${input.pod.id}`,
        `Control ${input.template.controlVersion}`,
      ].join("\n"),
      senderAccounts: input.emails,
      sequence: controlSequence(input.template, "Pod control"),
      folderId: input.folderId,
      providerIds: input.providerIds,
      campaignId: input.shellCampaignId,
      sequenceMappingId: input.sequenceMappingId,
    });
    const created = await this.smartDelivery.createAutomatedPlacement(
      isolationSchedulePayload(
        manual,
        this.config.placementTestEveryDays,
        scheduledAt,
        schedulerCronValue(this.config.placementTestEveryDays, scheduledAt),
        addDaysIso(
          new Date(),
          this.config.placementTestEndDays > 0
            ? this.config.placementTestEndDays
            : OPEN_ENDED_TEST_DAYS,
        ),
        input.providerIds,
      ),
    );
    return String(created.id);
  }

  private async readExisting(result: PodControlResult): Promise<void> {
    const senderTypes = await this.senderTypeMap();
    for (const row of this.state.listPodControls()) {
      try {
        const raw = await this.smartDelivery.getSenderAccountReport(row.spamTestId);
        const rates = parseSenderInboxRates(raw, row.spamTestId, {
          senderTypeByEmail: senderTypes,
          preferSameEsp: this.config.scoreSameEspOnly,
          minSameEspSamples: this.config.minSameEspSamples,
        });
        const placements: Array<"PRIMARY" | "SPAM" | "OTHER" | "UNKNOWN"> = [];
        for (const rate of rates) {
          const email = rate.email.toLowerCase();
          const placement = placementFromInboxRate({
            inboxRate: rate.inboxRate,
            scoredSameEsp: rate.scoredSameEsp,
            requireSameEsp: this.config.scoreSameEspOnly,
          });
          const previous = this.state.getMailboxControl(email);
          const history = [...(previous?.history ?? []), placement].slice(-8);
          this.state.upsertMailboxControl({
            email,
            podId: row.podId,
            lastTestId: row.spamTestId,
            ranAt: new Date().toISOString(),
            placement,
            inboxRate: rate.inboxRate,
            scoredSameEsp: rate.scoredSameEsp,
            history,
            rollingFailCount: rollingFailCount(history),
            tag: tagFromPlacements(history),
          });
          placements.push(placement);
          result.sendersRead += 1;
        }
        this.state.upsertPodControl({
          ...row,
          lastReadAt: new Date().toISOString(),
          verdict: podVerdictFromSenders(placements),
          sendersTested: rates.length,
          sendersFailing: placements.filter((placement) => placement === "SPAM")
            .length,
        });
      } catch (error) {
        result.errors.push(
          `read ${row.spamTestId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await sleep(150);
    }
  }

  private async senderTypeMap(): Promise<Map<string, string | undefined>> {
    const map = new Map<string, string | undefined>();
    try {
      const accounts = await this.smartlead.listAllEmailAccounts();
      for (const account of accounts) {
        const email = accountEmail(account)?.toLowerCase();
        if (email) map.set(email, account.type);
      }
    } catch {
      // same-ESP scoring falls back to UNKNOWN placements
    }
    return map;
  }

  private async ensureFolder(
    name: string,
    key: "podControls" | "teardowns",
  ): Promise<string | number | undefined> {
    const existing = this.state.getIsolation().folders[key];
    if (existing !== undefined) return existing;
    try {
      const listed = await this.smartDelivery.listFolders();
      const found = findFolderId(listed, name);
      if (found !== undefined) {
        this.state.patchIsolation({
          folders: { ...this.state.getIsolation().folders, [key]: found },
        });
        return found;
      }
      const created = await this.smartDelivery.createFolder(name);
      const id = folderIdOf(created);
      if (id !== undefined) {
        this.state.patchIsolation({
          folders: { ...this.state.getIsolation().folders, [key]: id },
        });
      }
      return id;
    } catch (error) {
      console.warn(
        `[pod-controls] folder ${name} failed:`,
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
  }

  private async shellCampaignId(): Promise<number | undefined> {
    try {
      const campaigns = await this.smartlead.listCampaigns();
      return campaigns.find(
        (campaign) => String(campaign.status ?? "").toUpperCase() === "ACTIVE",
      )?.id;
    } catch {
      return undefined;
    }
  }

  private async resolveProviderIds(): Promise<number[]> {
    try {
      const resolved = await this.smartDelivery.resolveProviderIds(
        this.config.providerIds,
      );
      if (resolved.length) return resolved;
    } catch (error) {
      console.warn(
        "[pod-controls] provider resolve failed:",
        error instanceof Error ? error.message : error,
      );
    }
    try {
      const tests = await this.smartDelivery.listTests();
      for (const test of tests) {
        const id = test.spam_test_id ?? test.id;
        if (id == null) continue;
        const details = await this.smartDelivery.getTestDetails(id);
        const raw =
          (details as { provider_id?: unknown; provider_ids?: unknown })
            .provider_id ??
          (details as { provider_ids?: unknown }).provider_ids;
        if (Array.isArray(raw) && raw.every((n) => typeof n === "number")) {
          return raw;
        }
      }
    } catch (error) {
      console.warn(
        "[pod-controls] provider fallback failed:",
        error instanceof Error ? error.message : error,
      );
    }
    return [];
  }

  private async shellSequenceMappingId(
    campaignId: number | undefined,
  ): Promise<number | undefined> {
    if (campaignId == null) return undefined;
    try {
      const sequences = await this.smartlead.getCampaignSequences(campaignId);
      const sequence = pickSequence(sequences ?? [], this.config.sequenceNumber);
      return sequence ? sequenceMappingIdOf(sequence) : undefined;
    } catch {
      return undefined;
    }
  }
}

function findFolderId(raw: unknown, name: string): string | number | undefined {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as Record<string, unknown>).data as unknown[]) ??
        ((raw as Record<string, unknown>).result as unknown[]) ??
        []
      : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    if (String(obj.name ?? obj.folder_name ?? "") === name) {
      return folderIdOf(obj);
    }
  }
  return undefined;
}
