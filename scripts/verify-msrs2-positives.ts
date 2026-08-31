import { SmartleadClient } from "../src/clients/smartlead.js";
import { apiRequest } from "../src/lib/http.js";

async function main() {
  const key = process.env.SMARTLEAD_API_KEY;
  if (!key) throw new Error("no key");
  const sl = new SmartleadClient(key);
  const id = 3867944;

  const a = await sl.getCampaignAnalyticsByDate(id, "2026-07-28", "2026-08-27");
  console.log("analytics-by-date", JSON.stringify(a).slice(0, 900));

  const top = await apiRequest(
    "https://server.smartlead.ai/api/v1/",
    key,
    `campaigns/${id}/analytics`,
  );
  console.log("analytics", JSON.stringify(top).slice(0, 900));

  let interested = 0;
  let categorized = 0;
  let offset = 0;
  for (;;) {
    const page = (await sl.getCampaignLeads(id, {
      limit: 100,
      offset,
    })) as {
      data?: Array<{ lead_category_id?: number | null }>;
    };
    const data = page.data ?? [];
    for (const row of data) {
      if (row.lead_category_id != null) categorized += 1;
      if (Number(row.lead_category_id) === 1) interested += 1;
    }
    offset += data.length;
    if (data.length < 100) break;
  }
  console.log({ interested, categorized });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
