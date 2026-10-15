import express, { type Express, type Request, type Response } from "express";
import { buildComparison, buildMetrics, canonCompliantFromFindings, countKinds } from "./compare.js";
import type { AppConfig } from "./config.js";
import { writesAllowed } from "./config.js";
import { ISOLATION_DEADLINE_MS } from "./canon/constants.js";
import { isolationOverdue, uglyWithoutIsolation } from "./lib/isolation.js";
import { isActiveStatus } from "./lib/staffable.js";
import type { V2Store } from "./store.js";
import type { OldWizardHealth } from "./types.js";

export function createApi(opts: { config: AppConfig; store: V2Store }): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", async (_req: Request, res: Response) => {
    try {
      const findings = await opts.store.listFindings();
      const stamps = await opts.store.listStamps();
      const scores = await opts.store.listScores();
      const suspects = await opts.store.listSuspects();
      const book = await opts.store.loadInventory();
      const runs = new Map<number, Awaited<ReturnType<V2Store["latestRun"]>>>();
      for (const score of scores) {
        runs.set(score.campaignId, await opts.store.latestRun(score.campaignId));
      }
      const holes = uglyWithoutIsolation({
        scores,
        suspects,
        latestRun: (id) => runs.get(id) ?? undefined,
        keepCampaignId: (id) =>
          Boolean(book?.campaigns.some((c) => c.id === id && isActiveStatus(c.status))),
      });
      const overdueHoles = holes.filter((h) => isolationOverdue(h.scoredAt));
      const overdueStages = stamps.filter((s) => {
        if (!s.lastOkAt) return true;
        return Date.now() - Date.parse(s.lastOkAt) > 20 * 60 * 1000;
      });
      res.json({
        ok: true,
        role: opts.config.role,
        shadow: opts.config.shadow,
        writeEnabled: opts.config.writeEnabled,
        writesAllowed: writesAllowed(opts.config),
        canonCompliant: canonCompliantFromFindings(findings) && overdueHoles.length === 0,
        canonFindings: countKinds(findings),
        placementIsolation: {
          scored: scores.length,
          ugly: scores.filter((s) => s.inboxPercent < 80).length,
          uglyWithoutIsolation: holes,
          isolationDeadlineMs: ISOLATION_DEADLINE_MS,
          overdueUgly: overdueHoles.length,
        },
        stageHealth: Object.fromEntries(stamps.map((s) => [s.stage, s])),
        overdueStages: overdueStages.map((s) => s.stage),
        inventoryFetchedAt: book?.fetchedAt ?? null,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/intended", async (req: Request, res: Response) => {
    const hours = Number(req.query.hours ?? 24);
    const since = new Date(Date.now() - hours * 3600_000);
    const rows = await opts.store.listIntended(since);
    res.json({ count: rows.length, actions: rows });
  });

  app.get("/findings", async (_req: Request, res: Response) => {
    res.json({ findings: await opts.store.listFindings() });
  });

  app.get("/compare", async (_req: Request, res: Response) => {
    try {
      const old = await fetchOldHealth(opts.config.oldWizardHealthUrl);
      const report = buildComparison({
        old,
        findings: await opts.store.listFindings(),
        intended: await opts.store.listIntended(new Date(Date.now() - 24 * 3600_000)),
        scores: await opts.store.listScores(),
        espInboxRates: await opts.store.listEspMatrix(),
        qaRuns: await opts.store.listQaRuns(),
      });
      await opts.store.saveComparison(report);
      res.json(report);
    } catch (error) {
      res.status(502).json({ ok: false, error: String(error) });
    }
  });

  app.get("/metrics", async (_req: Request, res: Response) => {
    try {
      res.json(
        buildMetrics({
          espInboxRates: await opts.store.listEspMatrix(),
          qaRuns: await opts.store.listQaRuns(),
        }),
      );
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/", (_req, res) => {
    res.json({
      name: "deliverability-wizard-v2",
      shadow: opts.config.shadow,
      writeEnabled: opts.config.writeEnabled,
      docs: ["GET /health", "GET /compare", "GET /metrics", "GET /intended", "GET /findings"],
    });
  });

  return app;
}

async function fetchOldHealth(url: string): Promise<OldWizardHealth | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return (await res.json()) as OldWizardHealth;
  } catch {
    return null;
  }
}
