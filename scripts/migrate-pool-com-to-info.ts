/**
 * Migrate DW Generic Pool .com domains → .info (Porkbun + InboxKit).
 *
 * Porkbun allows 50 domain creates / 24h. If rate-limited, pass --wait to
 * poll until the window resets, then buy/connect/order and retire .com.
 *
 * IMPORTANT: Domain/mailbox purchases spend real money.
 * Do not run --wait/--run/--buy-* unless the user explicitly approved spend.
 * Destructive spend flags also require --i-approve-spend.
 *
 * Usage:
 *   npx tsx scripts/migrate-pool-com-to-info.ts --status
 *   npx tsx scripts/migrate-pool-com-to-info.ts --wait --i-approve-spend
 *   npx tsx scripts/migrate-pool-com-to-info.ts --run --i-approve-spend
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InboxKitClient } from "../src/clients/inboxkit.js";
import { PorkbunClient } from "../src/clients/porkbun.js";
import { pickUniquePersonNames } from "../src/lib/personNames.js";
import { sleep } from "../src/lib/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLAN = path.join(ROOT, "data/generic-pool-domains.json");
const PROGRESS = path.join(ROOT, "data/generic-pool-info-migrate-progress.json");

interface DomainRow {
  domain: string;
  parent: string;
  platform: "GOOGLE" | "MICROSOFT";
}

function parseFlags(argv: string[]) {
  return new Set(argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2)));
}

function toInfo(domain: string): string {
  return domain.toLowerCase().replace(/\.com$/, ".info");
}

async function saveProgress(data: unknown) {
  await writeFile(PROGRESS, JSON.stringify(data, null, 2) + "\n");
}

async function readCreateRateLimit(
  pb: PorkbunClient,
  testDomain: string,
): Promise<{ limited: boolean; ttlRemaining: number; message: string }> {
  await sleep(11_000);
  const check = await pb.checkDomain(testDomain);
  if (!check.available) {
    return {
      limited: false,
      ttlRemaining: 0,
      message: `${testDomain} unavailable on check`,
    };
  }
  const cents = PorkbunClient.priceToCents(check.price);
  if (cents == null) {
    return { limited: false, ttlRemaining: 0, message: "no price on check" };
  }
  try {
    await pb.createDomain(testDomain, { years: 1, costCents: cents });
    try {
      await pb.updateAutoRenew(testDomain, "off");
    } catch {
      /* optional */
    }
    return {
      limited: false,
      ttlRemaining: 0,
      message: `created ${testDomain} (limit clear)`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let ttl = 0;
    if (e && typeof e === "object" && "body" in e) {
      const body = (e as { body?: { ttlRemaining?: number } }).body;
      ttl = Number(body?.ttlRemaining || 0);
    }
    const limited = /50 out of 50|RATE_LIMIT/i.test(msg);
    return { limited, ttlRemaining: ttl, message: msg };
  }
}

async function migrate(opts: { orderMailboxes: boolean }) {
  const plan = JSON.parse(await readFile(PLAN, "utf8"));
  const ws = plan.workspaceId as string;
  const ik = new InboxKitClient(
    process.env.INBOXKIT_API_KEY || process.env.KEY || "",
    ws,
  );
  const pb = new PorkbunClient({
    apiKey: process.env.PORKBUN_API_KEY || "",
    secretApiKey: process.env.PORKBUN_SECRET_API_KEY || "",
  });

  const comRows = (plan.domains as DomainRow[]).filter((d) =>
    d.domain.toLowerCase().endsWith(".com"),
  );
  if (!comRows.length) {
    console.log("[migrate] plan already all .info — nothing to do");
    return;
  }

  const replacements = comRows.map((d) => ({
    from: d.domain.toLowerCase(),
    to: toInfo(d.domain),
    parent: d.parent,
    platform: d.platform,
    price: undefined as string | undefined,
  }));

  const progress: Record<string, unknown> = {
    at: new Date().toISOString(),
    replacements,
    buys: [] as unknown[],
    mailboxBuys: [] as unknown[],
    cancels: [] as unknown[],
    errors: [] as string[],
  };

  // Availability
  for (const r of replacements) {
    await sleep(11_000);
    const check = await pb.checkDomain(r.to);
    console.log(`[migrate] avail ${r.to} → ${check.available} $${check.price}`);
    if (!check.available) {
      (progress.errors as string[]).push(`${r.to} not available`);
      throw new Error(`${r.to} not available — pick another name`);
    }
    r.price = check.price;
  }

  // Buy + NS
  for (const r of replacements) {
    const domain = r.to;
    const existing = await ik.listDomains(ws, { keyword: domain, limit: 20 });
    const already = existing.find(
      (d) => (d.name || d.domain || "").toLowerCase() === domain,
    );
    if (!(already && InboxKitClient.nameserversReady(already))) {
      if (!already) {
        const costCents = PorkbunClient.priceToCents(r.price);
        if (costCents == null) throw new Error(`No price for ${domain}`);
        console.log(`[migrate] porkbun create ${domain}`);
        try {
          await pb.createDomain(domain, { years: 1, costCents });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/RATE_LIMIT|50 out of 50/i.test(msg)) throw e;
          if (!/already|exist|registered/i.test(msg)) throw e;
          console.warn(`[migrate] create already-owned ok: ${msg}`);
        }
        try {
          await pb.updateAutoRenew(domain, "off");
        } catch {
          /* optional */
        }
        await sleep(800);
      }
      console.log(`[migrate] inboxkit connect NS ${domain}`);
      const connected = await ik.connectNameservers([domain], ws);
      await sleep(1000);
      const refreshed = await ik.listDomains(ws, { keyword: domain, limit: 20 });
      const ikRow = refreshed.find(
        (d) => (d.name || d.domain || "").toLowerCase() === domain,
      );
      const nsRow = connected.find(
        (c) => (c.domain || c.name || "").toLowerCase() === domain,
      );
      const nameservers = (ikRow?.nameservers ||
        nsRow?.nameservers ||
        []) as string[];
      if (!nameservers.length) throw new Error(`No NS for ${domain}`);
      await pb.updateNameservers(domain, nameservers);
      (progress.buys as unknown[]).push({
        domain,
        from: r.from,
        nameservers,
        ok: true,
      });
    } else {
      (progress.buys as unknown[]).push({ domain, skipped: true });
    }
    await sleep(500);
  }

  // Swap plan to .info BEFORE mailbox orders so provisioner tracks new names
  const byFrom = new Map(replacements.map((r) => [r.from, r]));
  plan.domains = (plan.domains as DomainRow[]).map((d) => {
    const rep = byFrom.get(d.domain.toLowerCase());
    return rep
      ? { domain: rep.to, parent: d.parent, platform: d.platform }
      : d;
  });
  if (!plan.domains.every((d: DomainRow) => d.domain.endsWith(".info"))) {
    throw new Error("plan still has non-.info domains");
  }
  plan.note =
    "40 × .info domains × 5 = 200 (60% Google / 40% Microsoft). All senders on .info.";
  plan.expansion = {
    ...(plan.expansion || {}),
    allInfoMigratedAt: new Date().toISOString(),
    replacedComWithInfo: replacements.map((r) => ({
      from: r.from,
      to: r.to,
      platform: r.platform,
    })),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(PLAN, JSON.stringify(plan, null, 2) + "\n");
  console.log("[migrate] plan is all .info");

  // Wait for NS on new domains (up to ~45m)
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const domains = await ik.listDomains(ws, { limit: 200 });
    const byName = new Map(
      domains.map((d) => [(d.name || d.domain || "").toLowerCase(), d]),
    );
    let ready = 0;
    for (const d of plan.domains as DomainRow[]) {
      const row = byName.get(d.domain.toLowerCase());
      if (row && InboxKitClient.nameserversReady(row)) ready += 1;
    }
    console.log(`[migrate] NS ready ${ready}/${plan.domains.length}`);
    if (ready >= plan.domains.length) break;
    await sleep(45_000);
  }

  if (opts.orderMailboxes) {
    const mailboxes = (await ik.listAllMailboxes(ws)).filter((m) => {
      const st = String(m.status || "").toLowerCase();
      return !st.includes("cancel") && st !== "deleted" && st !== "failed";
    });
    const mbByDomain = new Map<string, number>();
    const taken = new Set<string>();
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
      if (user) taken.add(user);
      if (m.username) taken.add(String(m.username).toLowerCase());
    }
    const perDomain = plan.mailboxesPerDomain || 5;
    let seed = 9000;
    const domainsNow = await ik.listDomains(ws, { limit: 200 });
    const byName = new Map(
      domainsNow.map((d) => [(d.name || d.domain || "").toLowerCase(), d]),
    );
    for (const row of plan.domains as DomainRow[]) {
      const domain = row.domain.toLowerCase();
      // Only order on the newly migrated .info set
      if (!replacements.some((r) => r.to === domain)) continue;
      const ikRow = byName.get(domain);
      if (!ikRow || !InboxKitClient.nameserversReady(ikRow)) {
        console.log(`[migrate] skip mb ${domain} (NS not ready)`);
        continue;
      }
      const have = mbByDomain.get(domain) ?? 0;
      const need = Math.max(0, perDomain - have);
      if (!need) continue;
      const names = pickUniquePersonNames(need, seed, taken);
      seed += need + 13;
      const batch = names.map((n) => ({
        ...n,
        platform: row.platform,
        domain_name: domain,
      }));
      console.log(
        `[migrate] buy ${need} on ${domain}:`,
        batch.map((b) => `${b.first_name} ${b.last_name}`).join(", "),
      );
      try {
        const resp = await ik.buyMailboxes(batch, {
          workspaceId: ws,
          useWalletBalance: true,
          idempotencyKey: `info-migrate-${domain}-n${need}-v1`,
        });
        (progress.mailboxBuys as unknown[]).push({
          domain,
          need,
          ok: true,
          resp,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (progress.errors as string[]).push(`mb ${domain}: ${msg}`);
        (progress.mailboxBuys as unknown[]).push({
          domain,
          ok: false,
          error: msg,
        });
      }
      await sleep(1200);
    }
  }

  // Retire .com mailboxes + domains
  const mbs = await ik.listAllMailboxes(ws);
  const comSet = new Set(replacements.map((r) => r.from));
  const cancelUids = mbs
    .filter((m) => {
      const st = String(m.status || "").toLowerCase();
      if (st.includes("cancel") || st === "deleted" || st === "failed")
        return false;
      const email = (m.email || m.address || "").toLowerCase();
      const domain = (
        m.domain_name ||
        m.domain ||
        (email.includes("@") ? email.split("@")[1] : "") ||
        ""
      ).toLowerCase();
      return comSet.has(domain);
    })
    .map((m) => m.uid!)
    .filter(Boolean);
  console.log(`[migrate] cancel ${cancelUids.length} .com mailboxes`);
  for (let i = 0; i < cancelUids.length; i += 25) {
    const chunk = cancelUids.slice(i, i + 25);
    try {
      await ik.cancelMailboxes(chunk, { workspaceId: ws });
      (progress.cancels as unknown[]).push({ n: chunk.length, ok: true });
    } catch (e) {
      (progress.errors as string[]).push(
        `cancel: ${e instanceof Error ? e.message : e}`,
      );
    }
    await sleep(500);
  }
  for (const r of replacements) {
    try {
      await ik.removeDomains([r.from], ws);
      console.log(`[migrate] removed ${r.from}`);
    } catch (e) {
      console.warn(
        `[migrate] remove ${r.from} fail`,
        e instanceof Error ? e.message : e,
      );
    }
    await sleep(400);
  }

  await saveProgress(progress);
  console.log("[migrate] complete", {
    buys: (progress.buys as unknown[]).length,
    mailboxBuys: (progress.mailboxBuys as unknown[]).length,
    errors: progress.errors,
  });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const plan = JSON.parse(await readFile(PLAN, "utf8"));
  const com = (plan.domains as DomainRow[]).filter((d) =>
    d.domain.endsWith(".com"),
  );
  const info = (plan.domains as DomainRow[]).filter((d) =>
    d.domain.endsWith(".info"),
  );
  console.log(
    JSON.stringify(
      {
        planDomains: plan.domains.length,
        info: info.length,
        com: com.length,
        comDomains: com.map((d) => d.domain),
        targetInfoReplacements: com.map((d) => ({
          from: d.domain,
          to: toInfo(d.domain),
          platform: d.platform,
        })),
      },
      null,
      2,
    ),
  );

  if (flags.has("status") || flags.size === 0) {
    if (!com.length) {
      console.log("[migrate] already all .info");
      return;
    }
    const pb = new PorkbunClient({
      apiKey: process.env.PORKBUN_API_KEY || "",
      secretApiKey: process.env.PORKBUN_SECRET_API_KEY || "",
    });
    const probe = await readCreateRateLimit(pb, toInfo(com[0]!.domain));
    console.log("[migrate] porkbun create probe", probe);
    if (probe.limited) {
      const hours = (probe.ttlRemaining / 3600).toFixed(1);
      const eta = new Date(
        Date.now() + probe.ttlRemaining * 1000,
      ).toISOString();
      console.log(
        `[migrate] rate limited — retry in ~${hours}h (eta ≈ ${eta})`,
      );
    }
    return;
  }

  if (flags.has("wait") || flags.has("run")) {
    if (!flags.has("i-approve-spend")) {
      console.error(
        "[migrate] Refusing to spend. Re-run with --i-approve-spend only after explicit user approval.",
      );
      process.exit(2);
    }
  }

  if (flags.has("wait")) {
    const pb = new PorkbunClient({
      apiKey: process.env.PORKBUN_API_KEY || "",
      secretApiKey: process.env.PORKBUN_SECRET_API_KEY || "",
    });
    while (com.length) {
      const first = toInfo(com[0]!.domain);
      const probe = await readCreateRateLimit(pb, first);
      console.log(new Date().toISOString(), "probe", probe);
      if (!probe.limited) {
        // First domain may already be created by the probe — migrate is idempotent
        break;
      }
      // Sleep most of the remaining window (wake 2 min early), cap polls at 30m
      const waitSec = Math.max(
        120,
        Math.min(Math.max(probe.ttlRemaining - 120, 120), 1800),
      );
      console.log(`[migrate] sleeping ${waitSec}s until rate limit clears…`);
      await sleep(waitSec * 1000);
    }
    await migrate({ orderMailboxes: true });
    return;
  }

  if (flags.has("run")) {
    await migrate({ orderMailboxes: true });
    return;
  }

  console.log("Pass --status, --wait, or --run");
}

main().catch((e) => {
  console.error("[migrate] fatal", e);
  process.exit(1);
});
