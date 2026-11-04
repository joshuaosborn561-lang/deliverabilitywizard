import type { TestedCampaignRecord } from "../state/store.js";

/**
 * D326 — SmartDelivery's report list omits `campaign_id`, and the monitor
 * never enriches it, so every live under-80 read logged "no ACTIVE live
 * campaign to queue" (62 tests on 2026-11-02..04, all on ACTIVE campaigns).
 * The scanner already records which campaign each test it created belongs to
 * (`testedCampaigns[campaignId].testIds`). Reverse that record so a test the
 * Wizard created maps back to its campaign without another API call.
 *
 * This is not a guess (D121): it is the Wizard's own creation record. An id
 * claimed by two campaigns is ambiguous and maps to nothing.
 */
export function trackedTestCampaignIndex(
  testedCampaigns: Record<string, TestedCampaignRecord | undefined>,
): Map<string, number> {
  const out = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const [key, record] of Object.entries(testedCampaigns)) {
    if (!record?.testIds?.length) continue;
    const campaignId = Number(record.campaignId ?? key);
    if (!Number.isFinite(campaignId)) continue;
    for (const raw of record.testIds) {
      const id = String(raw);
      if (ambiguous.has(id)) continue;
      const prior = out.get(id);
      if (prior !== undefined && prior !== campaignId) {
        out.delete(id);
        ambiguous.add(id);
        continue;
      }
      out.set(id, campaignId);
    }
  }
  return out;
}
