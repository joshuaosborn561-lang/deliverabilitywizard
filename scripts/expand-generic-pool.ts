/**
 * Expand DW Generic Pool to 240 mailboxes (5/domain, ~60% Google / 40% Microsoft).
 *
 * Steps:
 *  1) Buy any missing .info domains on Porkbun
 *  2) Connect them in InboxKit (Cloudflare NS) + push NS at Porkbun
 *  3) Order missing mailboxes on domains whose NS already match (incl. top-ups 3→5)
 *
 * Cron pool provisioner finishes export + warmup after mailboxes go active.
 *
 * Usage:
 *   npx tsx scripts/expand-generic-pool.ts --status
 *   npx tsx scripts/expand-generic-pool.ts --buy-domains          # Porkbun .info
 *   npx tsx scripts/expand-generic-pool.ts --buy-domains-inboxkit # InboxKit .com/.net/.org/.shop
 *   npx tsx scripts/expand-generic-pool.ts --buy-mailboxes
 *   npx tsx scripts/expand-generic-pool.ts --all
 *
 * Env: PORKBUN_API_KEY, PORKBUN_SECRET_API_KEY (Porkbun path), INBOXKIT_API_KEY,
 *      GENERIC_POOL_WORKSPACE_ID (optional; plan file has workspaceId),
 *      DOMAIN_CONTACT_* (optional overrides for InboxKit WHOIS contact)
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InboxKitClient } from "../src/clients/inboxkit.js";
import { PorkbunClient } from "../src/clients/porkbun.js";
import { sleep } from "../src/lib/http.js";
import { pickUniquePersonNames } from "../src/lib/personNames.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLAN_PATH = path.join(ROOT, "data/generic-pool-domains.json");
const PROGRESS_PATH = path.join(ROOT, "data/generic-pool-expand-progress.json");

interface PoolPlan {
  workspaceId: string;
  mailboxesPerDomain: number;
  domains: Array<{
    domain: string;
    parent: string;
    platform: "GOOGLE" | "MICROSOFT";
  }>;
}

function parseArgs(argv: string[]) {
  const flags = new Set<string>();
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a.slice(2));
  }
  return flags;
}

async function loadPlan(): Promise<PoolPlan> {
  return JSON.parse(await readFile(PLAN_PATH, "utf8")) as PoolPlan;
}

async function saveProgress(data: unknown): Promise<void> {
  await writeFile(PROGRESS_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const plan = await loadPlan();
  const workspaceId =
    process.env.GENERIC_POOL_WORKSPACE_ID || plan.workspaceId;
  const perDomain = plan.mailboxesPerDomain || 5;
  const target = plan.domains.length * perDomain;

  const ik = new InboxKitClient(
    process.env.INBOXKIT_API_KEY || process.env.KEY || "",
    workspaceId,
  );
  if (!process.env.INBOXKIT_API_KEY && !process.env.KEY) {
    throw new Error("INBOXKIT_API_KEY required");
  }

  const porkbunKey = process.env.PORKBUN_API_KEY || "";
  const porkbunSecret = process.env.PORKBUN_SECRET_API_KEY || "";
  const porkbun =
    porkbunKey && porkbunSecret
      ? new PorkbunClient({ apiKey: porkbunKey, secretApiKey: porkbunSecret })
      : null;

  const ikDomains = await ik.listDomains(workspaceId, { limit: 200 });
  const byName = new Map(
    ikDomains.map((d) => [(d.name || d.domain || "").toLowerCase(), d]),
  );

  const mailboxes = await ik.listAllMailboxes(workspaceId);
  const mbByDomain = new Map<string, number>();
  const takenUsernames = new Set<string>();
  for (const m of mailboxes) {
    const email = (m.email || m.address || "").toLowerCase();
    const domain = (
      m.domain_name ||
      m.domain ||
      (email.includes("@") ? email.split("@")[1] : "") ||
      ""
    ).toLowerCase();
    if (domain) mbByDomain.set(domain, (mbByDomain.get(domain) ?? 0) + 1);
    const user = email.split("@")[0];
    if (user) takenUsernames.add(user);
    if (m.username) takenUsernames.add(String(m.username).toLowerCase());
  }

  const missingInIk = plan.domains.filter(
    (d) => !byName.has(d.domain.toLowerCase()),
  );
  const nsPending = plan.domains.filter((d) => {
    const row = byName.get(d.domain.toLowerCase());
    return !row || !InboxKitClient.nameserversReady(row);
  });
  const mailboxGaps = plan.domains
    .map((d) => {
      const have = mbByDomain.get(d.domain.toLowerCase()) ?? 0;
      return {
        domain: d.domain,
        platform: d.platform,
        have,
        need: Math.max(0, perDomain - have),
        nsReady: (() => {
          const row = byName.get(d.domain.toLowerCase());
          return Boolean(row && InboxKitClient.nameserversReady(row));
        })(),
      };
    })
    .filter((g) => g.need > 0);

  const gDomains = plan.domains.filter((d) => d.platform === "GOOGLE").length;
  const mDomains = plan.domains.filter((d) => d.platform === "MICROSOFT").length;

  console.log(
    JSON.stringify(
      {
        targetMailboxes: target,
        planDomains: plan.domains.length,
        googleDomains: gDomains,
        microsoftDomains: mDomains,
        perDomain,
        inboxkitDomains: ikDomains.length,
        inboxkitMailboxes: mailboxes.length,
        missingInInboxKit: missingInIk.map((d) => d.domain),
        nsPending: nsPending.map((d) => d.domain),
        mailboxGaps: mailboxGaps.length,
        mailboxesStillToOrder: mailboxGaps.reduce((a, b) => a + b.need, 0),
      },
      null,
      2,
    ),
  );

  if (flags.has("status") || flags.size === 0) {
    return;
  }

  const doDomainsPorkbun = flags.has("buy-domains");
  const doDomainsInboxkit =
    flags.has("buy-domains-inboxkit") || flags.has("all");
  const doMailboxes = flags.has("buy-mailboxes") || flags.has("all");
  const progress: Record<string, unknown> = {
    at: new Date().toISOString(),
    domainBuys: [] as unknown[],
    mailboxBuys: [] as unknown[],
    errors: [] as string[],
  };

  const pendingPayment = plan.domains.filter((d) => {
    const row = byName.get(d.domain.toLowerCase());
    return row && String(row.status || "").toLowerCase() === "pending_payment";
  });
  const toRegisterIk = [
    ...missingInIk,
    ...pendingPayment.filter(
      (d) => !missingInIk.some((m) => m.domain.toLowerCase() === d.domain.toLowerCase()),
    ),
  ];

  if (doDomainsInboxkit && toRegisterIk.length) {
    const contact = {
      first_name: process.env.DOMAIN_CONTACT_FIRST || "Joshua",
      last_name: process.env.DOMAIN_CONTACT_LAST || "Osborn",
      email:
        process.env.DOMAIN_CONTACT_EMAIL || "joshuaosborn561@gmail.com",
      phone: process.env.DOMAIN_CONTACT_PHONE || "+15125551212",
      organization: process.env.DOMAIN_CONTACT_ORG || "Optimal Falcon",
      address_line1:
        process.env.DOMAIN_CONTACT_ADDRESS || "1201 Orange St Ste 600",
      city: process.env.DOMAIN_CONTACT_CITY || "Wilmington",
      state: process.env.DOMAIN_CONTACT_STATE || "DE",
      country: process.env.DOMAIN_CONTACT_COUNTRY || "US",
      postal_code: process.env.DOMAIN_CONTACT_POSTAL || "19801",
    };
    try {
      const wallet = await ik.getWalletDetails();
      console.log(
        `[expand] wallet credits_remaining=${wallet.credits_remaining} auto_topup=${wallet.auto_topup_enabled}`,
      );
    } catch (e) {
      console.warn(
        `[expand] wallet lookup failed:`,
        e instanceof Error ? e.message : e,
      );
    }
    // Pay from wallet (not Stripe). If a domain is stuck in pending_payment
    // from an earlier Stripe session, delete it then re-register with wallet.
    for (const row of toRegisterIk) {
      const name = row.domain.toLowerCase();
      const existing = byName.get(name);
      const pending =
        existing &&
        String(existing.status || "").toLowerCase() === "pending_payment";
      try {
        if (pending) {
          console.log(`[expand] clear pending_payment ${name}`);
          await ik.removeDomains([name], workspaceId);
          await sleep(800);
        }
        console.log(`[expand] InboxKit register (wallet) ${name}`);
        const resp = await ik.registerDomains(
          [{ name, registration_years: 1 }],
          contact,
          workspaceId,
          { useWalletBalance: true },
        );
        const paymentType = (resp as { payment_type?: string }).payment_type;
        const stripeUrl = (resp as { url?: string }).url;
        if (stripeUrl && paymentType !== "wallet") {
          throw new Error(
            `Stripe checkout for ${name}; fund wallet and retry with use_wallet_balance`,
          );
        }
        (progress.domainBuys as unknown[]).push({
          domain: row.domain,
          platform: row.platform,
          via: "inboxkit-wallet",
          ok: true,
          resp,
        });
        await sleep(700);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[expand] register failed ${name}:`, message);
        (progress.errors as string[]).push(`${row.domain}: ${message}`);
        (progress.domainBuys as unknown[]).push({
          domain: row.domain,
          ok: false,
          via: "inboxkit",
          error: message,
        });
      }
    }
  }

  if (doDomainsPorkbun) {
    if (!porkbun) {
      throw new Error("PORKBUN_API_KEY + PORKBUN_SECRET_API_KEY required");
    }
    // Refresh missing list after any InboxKit buys
    const afterIk = await ik.listDomains(workspaceId, { limit: 200 });
    const afterByName = new Map(
      afterIk.map((d) => [(d.name || d.domain || "").toLowerCase(), d]),
    );
    const stillMissing = plan.domains.filter(
      (d) => !afterByName.has(d.domain.toLowerCase()),
    );
    for (const row of stillMissing) {
      const domain = row.domain.toLowerCase();
      try {
        console.log(`[expand] check ${domain}`);
        const check = await porkbun.checkDomainThrottled(domain);
        if (!check.available) {
          console.warn(`[expand] NOT available: ${domain}`, check.price);
          (progress.errors as string[]).push(`${domain}: not available`);
          continue;
        }
        const costCents = PorkbunClient.priceToCents(check.price);
        if (costCents == null) {
          throw new Error(`No price from check for ${domain}`);
        }
        console.log(
          `[expand] buy ${domain} @ $${check.price} (${costCents}¢)`,
        );
        await porkbun.createDomain(domain, { years: 1, costCents });
        try {
          await porkbun.updateAutoRenew(domain, "off");
        } catch {
          /* optional */
        }

        console.log(`[expand] connect InboxKit NS ${domain}`);
        const connected = await ik.connectNameservers([domain], workspaceId);
        const nsRow = connected.find(
          (c) => (c.domain || c.name || "").toLowerCase() === domain,
        );
        await sleep(800);
        const refreshed = await ik.listDomains(workspaceId, {
          keyword: domain,
          limit: 20,
        });
        const ikRow = refreshed.find(
          (d) => (d.name || d.domain || "").toLowerCase() === domain,
        );
        const nameservers = (ikRow?.nameservers ||
          nsRow?.nameservers ||
          []) as string[];
        if (!nameservers.length) {
          throw new Error(`No Cloudflare NS returned for ${domain}`);
        }
        console.log(
          `[expand] set Porkbun NS ${domain} → ${nameservers.join(",")}`,
        );
        await porkbun.updateNameservers(domain, nameservers);
        (progress.domainBuys as unknown[]).push({
          domain,
          platform: row.platform,
          price: check.price,
          nameservers,
          via: "porkbun",
          ok: true,
        });
        await sleep(500);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[expand] domain failed ${domain}:`, message);
        (progress.errors as string[]).push(`${domain}: ${message}`);
        (progress.domainBuys as unknown[]).push({
          domain,
          ok: false,
          via: "porkbun",
          error: message,
        });
      }
    }
  }

  if (doMailboxes) {
    // Refresh domain/NS state after buys
    const freshDomains = await ik.listDomains(workspaceId, { limit: 200 });
    const freshByName = new Map(
      freshDomains.map((d) => [(d.name || d.domain || "").toLowerCase(), d]),
    );
    let seed = mailboxes.length + 1000;
    for (const gap of mailboxGaps) {
      const ikRow = freshByName.get(gap.domain.toLowerCase());
      if (!ikRow || !InboxKitClient.nameserversReady(ikRow)) {
        console.log(`[expand] skip mailboxes ${gap.domain} (NS not ready)`);
        continue;
      }
      if (gap.need <= 0) continue;
      const names = pickUniquePersonNames(gap.need, seed, takenUsernames);
      seed += gap.need + 7;
      const batch = names.map((n) => ({
        ...n,
        platform: gap.platform,
        domain_name: gap.domain,
      }));
      try {
        console.log(
          `[expand] buy ${gap.need} ${gap.platform} mailbox(es) on ${gap.domain}:`,
          batch.map((b) => `${b.first_name} ${b.last_name}`).join(", "),
        );
        const resp = await ik.buyMailboxes(batch, {
          workspaceId,
          useWalletBalance: true,
          idempotencyKey: `pool-expand-${gap.domain}-${gap.platform}-n${gap.need}-v1`,
        });
        (progress.mailboxBuys as unknown[]).push({
          domain: gap.domain,
          need: gap.need,
          names: batch.map((b) => `${b.first_name} ${b.last_name}`),
          ok: true,
          resp,
        });
        await sleep(1200);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[expand] mailbox buy failed ${gap.domain}:`, message);
        (progress.errors as string[]).push(`mb ${gap.domain}: ${message}`);
        (progress.mailboxBuys as unknown[]).push({
          domain: gap.domain,
          ok: false,
          error: message,
        });
      }
    }
  }

  await saveProgress(progress);
  console.log(`[expand] progress written to ${PROGRESS_PATH}`);
  console.log(
    JSON.stringify(
      {
        domainBuys: (progress.domainBuys as unknown[]).length,
        mailboxBuys: (progress.mailboxBuys as unknown[]).length,
        errors: progress.errors,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[expand] fatal", error);
  process.exit(1);
});
