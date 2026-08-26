import { clientDisplayName, type SmartleadClientRecord } from "../clients/smartlead.js";

/** Strip "Logo (Person)" client display names down to the brand/logo. */
export function brandFromClientDisplayName(clientName: string): string {
  return clientName.replace(/\s*\(.*?\)\s*$/, "").trim() || clientName.trim();
}

export function normalizeBrand(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function clientBrandList(clients: SmartleadClientRecord[]): string[] {
  const out = new Set<string>();
  for (const client of clients) {
    const display = clientDisplayName(client);
    const brand = brandFromClientDisplayName(display);
    if (brand) out.add(brand);
    const logo = client.logo?.trim();
    if (logo) out.add(logo);
    const name = client.name?.trim();
    if (name && name.length >= 5) out.add(name);
  }
  return [...out];
}

/** True when `hay` carries this brand as a whole phrase, not a short token. */
export function brandInText(hay: string, brand: string): boolean {
  const text = normalizeBrand(hay);
  const needle = normalizeBrand(brand);
  if (!text || !needle || needle.length < 5) return false;
  if (text === needle || text.includes(needle)) return true;
  const tokens = needle.split(" ").filter((token) => token.length >= 4);
  return tokens.length >= 2 && tokens.every((token) => text.includes(token));
}

export function findForeignBrand(
  hay: string,
  ownBrand: string,
  allBrands: string[],
): string | null {
  const others = allBrands.filter(
    (brand) => brand && !brandInText(ownBrand, brand) && !brandInText(brand, ownBrand),
  );
  const hits = others
    .filter((brand) => brandInText(hay, brand))
    .sort((a, b) => normalizeBrand(b).length - normalizeBrand(a).length);
  return hits[0] ?? null;
}
