import { loadConfig } from "../src/config.js";
import {
  SmartleadClient,
  accountEmail,
  campaignIdsOf,
  clientDisplayName,
} from "../src/clients/smartlead.js";
import { brandFromClientDisplayName, clientBrandList, findForeignBrand } from "../src/lib/clientBrand.js";
import { signatureHay } from "../src/lib/signatureQa.js";
import { allowsGenericStaff } from "../src/lib/clientStaffFloor.js";

const sl = new SmartleadClient(loadConfig(process.env).smartleadApiKey);
const [campaigns, accounts, clients] = await Promise.all([
  sl.listCampaigns(),
  sl.listAllEmailAccounts({ fetchCampaigns: true }),
  sl.listClients(),
]);
const brandByClientId = new Map(
  clients.map((c) => [c.id, brandFromClientDisplayName(clientDisplayName(c))]),
);
const allBrands = clientBrandList(clients);
const goliath = campaigns.filter((c) => {
  const name = clientDisplayName(
    typeof c.client_id === "number" ? clients.find((x) => x.id === c.client_id) : undefined,
  );
  return allowsGenericStaff(c, name, ["goliath"]) || /ackley/i.test(name);
});
const live = goliath.filter((c) => String(c.status).toUpperCase() === "ACTIVE");
const hits = [];
for (const campaign of live) {
  const expected =
    typeof campaign.client_id === "number" ? brandByClientId.get(campaign.client_id) ?? "" : "";
  for (const account of accounts) {
    if (!campaignIdsOf(account).includes(campaign.id)) continue;
    const hay = signatureHay({ fromName: account.from_name, signature: account.signature });
    const foreign = findForeignBrand(hay, expected, allBrands);
    if (foreign) {
      hits.push({
        campaign: campaign.name,
        email: accountEmail(account),
        from_name: account.from_name,
        signature: account.signature,
        foreign,
        expected,
      });
    }
  }
}
console.log(JSON.stringify({ live: live.length, mismatches: hits.length, hits }, null, 2));
