/**
 * Diverse first/last names for pool mailboxes.
 * Intentionally multicultural — avoid a wall of generic Anglo unisex names.
 */

export const FIRST_NAMES = [
  // Anglo / Western European
  "James",
  "Emily",
  "Owen",
  "Claire",
  "Nathan",
  "Grace",
  "Patrick",
  "Helen",
  // Hispanic / Latino
  "Carlos",
  "Sofia",
  "Diego",
  "Isabella",
  "Miguel",
  "Camila",
  "Javier",
  "Valentina",
  "Andres",
  "Lucia",
  // East / Southeast Asian
  "Wei",
  "Mei",
  "Hiro",
  "Yuki",
  "Kenji",
  "Aiko",
  "Minh",
  "Lan",
  "Jin",
  "Hana",
  // South Asian
  "Aarav",
  "Priya",
  "Rohan",
  "Ananya",
  "Vikram",
  "Neha",
  "Arjun",
  "Isha",
  // Middle Eastern / North African
  "Omar",
  "Layla",
  "Yusuf",
  "Amira",
  "Samir",
  "Noor",
  "Karim",
  "Leila",
  // African / African diaspora
  "Kwame",
  "Amina",
  "Tunde",
  "Zuri",
  "Malik",
  "Imani",
  "Kofi",
  "Nia",
  // Slavic / Eastern European
  "Pavel",
  "Anya",
  "Marek",
  "Katya",
  "Ivan",
  "Nina",
  // Additional mixed common US names
  "Marcus",
  "Jasmine",
  "Derek",
  "Angela",
  "Tony",
  "Michelle",
  "Brian",
  "Stephanie",
  "Raymond",
  "Patricia",
  "Keith",
  "Denise",
  "Troy",
  "Monica",
  "Curtis",
  "Diana",
] as const;

export const LAST_NAMES = [
  // Anglo
  "Brooks",
  "Coleman",
  "Hayes",
  "Foster",
  "Bennett",
  "Griffin",
  "Walsh",
  "Keller",
  // Hispanic / Latino
  "Garcia",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Gonzalez",
  "Perez",
  "Sanchez",
  "Ramirez",
  "Torres",
  // East / Southeast Asian
  "Nguyen",
  "Tran",
  "Kim",
  "Park",
  "Chen",
  "Wang",
  "Liu",
  "Nakamura",
  "Tanaka",
  "Suzuki",
  // South Asian
  "Patel",
  "Shah",
  "Singh",
  "Khan",
  "Sharma",
  "Gupta",
  "Reddy",
  "Mehta",
  // Middle Eastern / North African
  "Hassan",
  "Ali",
  "Rahman",
  "Ibrahim",
  "Abbas",
  "Farouk",
  // African / diaspora
  "Okoye",
  "Mensah",
  "Abebe",
  "Diallo",
  "Okafor",
  "Boateng",
  // Slavic / other European
  "Novak",
  "Kowalski",
  "Petrov",
  "Horvat",
  "Rossi",
  "Costa",
  // Additional US-common
  "Washington",
  "Jefferson",
  "Bailey",
  "Reed",
  "Morgan",
  "Bryant",
  "Jenkins",
  "Porter",
] as const;

export interface PersonName {
  first_name: string;
  last_name: string;
  username: string;
}

/** Deterministic diverse name from a seed (stable across restarts). */
export function pickPersonName(seed: number): PersonName {
  const s = Math.abs(seed) >>> 0;
  // Mix first/last with different primes so consecutive seeds rarely collide
  const first = FIRST_NAMES[s % FIRST_NAMES.length]!;
  const last =
    LAST_NAMES[
      ((s * 2654435761) >>> 0) % LAST_NAMES.length
    ]!;
  const username = `${first}${last}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  return { first_name: first, last_name: last, username };
}

/** Avoid colliding usernames / last-name clumps within a batch. */
export function pickUniquePersonNames(
  count: number,
  startSeed: number,
  taken: Set<string> = new Set(),
): PersonName[] {
  const out: PersonName[] = [];
  const usedLast = new Set<string>();
  let seed = startSeed;
  let guard = 0;
  while (out.length < count && guard < count * 80) {
    guard += 1;
    const name = pickPersonName(seed++);
    if (taken.has(name.username)) continue;
    // Prefer unique last names inside the batch (then across recent picks)
    if (usedLast.has(name.last_name.toLowerCase()) && guard < count * 40) {
      continue;
    }
    taken.add(name.username);
    usedLast.add(name.last_name.toLowerCase());
    out.push(name);
  }
  if (out.length < count) {
    throw new Error(
      `Could only generate ${out.length}/${count} unique mailbox names`,
    );
  }
  return out;
}
