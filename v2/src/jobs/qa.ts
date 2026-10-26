import { randomUUID } from "node:crypto";
import { QA_LEASE_NAME, QA_LEASE_TTL_MS } from "../canon/constants.js";
import { isActiveStatus } from "../lib/staffable.js";
import { qaCopyAndLeads } from "../lib/qa.js";
import { clientBrandFromRecord, clientBrandList } from "../lib/signature.js";
import type { WriteGate } from "../shadow.js";
import type { V2Store } from "../store.js";
import type {
  Finding,
  IntendedAction,
  InventoryBook,
  LeadSample,
  QaRole,
  QaTrigger,
  SequenceSample,
} from "../types.js";

export interface QaTickResult {
  findings: Finding[];
  intended: IntendedAction[];
  acquired: boolean;
  runId?: string;
}

export async function runQaTick(opts: {
  book: InventoryBook;
  role: QaRole;
  trigger: QaTrigger;
  store: V2Store;
  gate: WriteGate;
  sequences?: SequenceSample[];
  leads?: LeadSample[];
  now?: Date;
}): Promise<QaTickResult> {
  const now = opts.now ?? new Date();
  const scheduled = await opts.store.insertQaRun({
    id: randomUUID(),
    scheduledAt: now.toISOString(),
    role: opts.role,
    status: "scheduled",
    trigger: opts.trigger,
    detail: `${QA_LEASE_NAME} ${opts.role}`,
  });

  const lease = await opts.store.acquireQaLease(opts.role, QA_LEASE_TTL_MS, now);
  if (!lease.acquired || !lease.token) {
    await opts.store.completeQaRun(scheduled.id, {
      status: "missed",
      detail: `lease held by another role`,
    });
    return { findings: [], intended: [], acquired: false, runId: scheduled.id };
  }

  await opts.store.completeQaRun(scheduled.id, {
    status: "running",
    startedAt: now.toISOString(),
    role: opts.role,
  });

  const findings: Finding[] = [];
  const intended: IntendedAction[] = [];
  try {
    const clients = new Map<number, string>();
    for (const c of opts.book.clients ?? []) {
      const brand = clientBrandFromRecord(c);
      if (brand) clients.set(c.id, brand);
    }
    const allBrands = clientBrandList(opts.book.clients ?? []);
    for (const campaign of opts.book.campaigns) {
      if (!isActiveStatus(campaign.status)) continue;
      const members = opts.book.accounts.filter((a) => a.campaignIds.includes(campaign.id));
      const rows = qaCopyAndLeads({
        campaign,
        members,
        sequences: opts.sequences,
        leads: opts.leads,
        clientBrand: campaign.clientId != null ? clients.get(campaign.clientId) : undefined,
        otherClientBrands: allBrands,
      });
      findings.push(...rows);
      for (const f of rows) {
        if (f.kind === "merge_tag_blank") {
          intended.push(
            (
              await opts.gate.intend({
                kind: "slack",
                campaignId: campaign.id,
                payload: { kind: "ops_alert", reason: "merge_tag_blank", detail: f.detail },
                run: async () => undefined,
              })
            ).action,
          );
        }
      }
    }
    await opts.store.completeQaRun(scheduled.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      findings,
    });
    return { findings, intended, acquired: true, runId: scheduled.id };
  } finally {
    await opts.store.releaseQaLease(opts.role, lease.token);
  }
}
