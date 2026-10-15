import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type {
  Finding,
  GenericSeat,
  IntendedAction,
  InventoryBook,
  IsolationRun,
  IsolationSuspect,
  PlacementScore,
  SlimAccount,
  SlimCampaign,
  StageStamp,
} from "./types.js";

const { Pool } = pg;

export interface V2Store {
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  saveInventory(book: InventoryBook): Promise<void>;
  loadInventory(): Promise<InventoryBook | null>;
  replaceFindings(rows: Finding[]): Promise<void>;
  listFindings(): Promise<Finding[]>;
  logIntended(action: IntendedAction): Promise<IntendedAction>;
  listIntended(since?: Date): Promise<IntendedAction[]>;
  upsertScore(score: PlacementScore): Promise<void>;
  listScores(): Promise<PlacementScore[]>;
  upsertSuspect(row: IsolationSuspect): Promise<void>;
  listSuspects(): Promise<IsolationSuspect[]>;
  insertRun(run: IsolationRun): Promise<void>;
  latestRun(campaignId: number): Promise<IsolationRun | undefined>;
  stampOk(stage: string, at?: Date): Promise<void>;
  stampError(stage: string, error: string, at?: Date): Promise<void>;
  listStamps(): Promise<StageStamp[]>;
  upsertGeneric(seat: GenericSeat): Promise<void>;
  listGenerics(): Promise<GenericSeat[]>;
  saveComparison(report: unknown): Promise<void>;
}

export class MemoryStore implements V2Store {
  inventory: InventoryBook | null = null;
  findings: Finding[] = [];
  intended: IntendedAction[] = [];
  scores: PlacementScore[] = [];
  suspects: IsolationSuspect[] = [];
  runs: IsolationRun[] = [];
  stamps = new Map<string, StageStamp>();
  generics: GenericSeat[] = [];
  comparisons: unknown[] = [];

  async migrate(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
  async saveInventory(book: InventoryBook): Promise<void> {
    this.inventory = structuredClone(book);
  }
  async loadInventory(): Promise<InventoryBook | null> {
    return this.inventory ? structuredClone(this.inventory) : null;
  }
  async replaceFindings(rows: Finding[]): Promise<void> {
    this.findings = rows.map((r) => ({ ...r, at: r.at ?? new Date().toISOString() }));
  }
  async listFindings(): Promise<Finding[]> {
    return [...this.findings];
  }
  async logIntended(action: IntendedAction): Promise<IntendedAction> {
    const row: IntendedAction = {
      ...action,
      id: this.intended.length + 1,
      at: action.at ?? new Date().toISOString(),
    };
    this.intended.push(row);
    return row;
  }
  async listIntended(since?: Date): Promise<IntendedAction[]> {
    if (!since) return [...this.intended];
    return this.intended.filter((a) => Date.parse(a.at ?? "") >= since.getTime());
  }
  async upsertScore(score: PlacementScore): Promise<void> {
    this.scores = this.scores.filter((s) => s.campaignId !== score.campaignId);
    this.scores.push(score);
  }
  async listScores(): Promise<PlacementScore[]> {
    return [...this.scores];
  }
  async upsertSuspect(row: IsolationSuspect): Promise<void> {
    this.suspects = this.suspects.filter((s) => s.campaignId !== row.campaignId);
    this.suspects.push(row);
  }
  async listSuspects(): Promise<IsolationSuspect[]> {
    return [...this.suspects];
  }
  async insertRun(run: IsolationRun): Promise<void> {
    this.runs.push(run);
  }
  async latestRun(campaignId: number): Promise<IsolationRun | undefined> {
    return [...this.runs].reverse().find((r) => r.campaignId === campaignId);
  }
  async stampOk(stage: string, at = new Date()): Promise<void> {
    this.stamps.set(stage, {
      stage,
      lastOkAt: at.toISOString(),
      consecutiveFailures: 0,
    });
  }
  async stampError(stage: string, error: string, at = new Date()): Promise<void> {
    const prev = this.stamps.get(stage);
    this.stamps.set(stage, {
      stage,
      lastOkAt: prev?.lastOkAt,
      lastErrorAt: at.toISOString(),
      lastError: error,
      consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
    });
  }
  async listStamps(): Promise<StageStamp[]> {
    return [...this.stamps.values()];
  }
  async upsertGeneric(seat: GenericSeat): Promise<void> {
    this.generics = this.generics.filter((g) => g.accountId !== seat.accountId);
    this.generics.push(seat);
  }
  async listGenerics(): Promise<GenericSeat[]> {
    return [...this.generics];
  }
  async saveComparison(report: unknown): Promise<void> {
    this.comparisons.push(report);
  }
}

export class PostgresStore implements V2Store {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 4 });
  }

  async migrate(): Promise<void> {
    const sqlPath = join(process.cwd(), "sql/schema.sql");
    const sql = await readFile(sqlPath, "utf8");
    await this.pool.query(sql);
  }

  async ping(): Promise<boolean> {
    const r = await this.pool.query("SELECT 1");
    return r.rowCount === 1;
  }

  async saveInventory(book: InventoryBook): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM inventory_campaigns");
      await client.query("DELETE FROM inventory_accounts");
      for (const c of book.campaigns) {
        await client.query(
          `INSERT INTO inventory_campaigns (id, name, status, client_id, min_time_btwn_emails, updated_at)
           VALUES ($1,$2,$3,$4,$5,NOW())`,
          [c.id, c.name, c.status, c.clientId, c.minTimeBtwnEmails ?? null],
        );
      }
      for (const a of book.accounts) {
        await client.query(
          `INSERT INTO inventory_accounts
            (id, email, from_name, client_id, campaign_ids, tags, smtp_ok, imap_ok,
             message_per_day, warmup_blocked, created_at, warmup_started_at, signature, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
          [
            a.id,
            a.email,
            a.fromName,
            a.clientId,
            a.campaignIds,
            a.tags,
            a.smtpOk,
            a.imapOk,
            a.messagePerDay,
            a.warmupBlocked,
            a.createdAt,
            a.warmupStartedAt,
            a.signature,
          ],
        );
      }
      await client.query(
        `INSERT INTO inventory_meta (id, fetched_at, campaign_count, account_count)
         VALUES (1, $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET fetched_at = EXCLUDED.fetched_at,
           campaign_count = EXCLUDED.campaign_count, account_count = EXCLUDED.account_count`,
        [book.fetchedAt, book.campaigns.length, book.accounts.length],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadInventory(): Promise<InventoryBook | null> {
    const meta = await this.pool.query("SELECT fetched_at FROM inventory_meta WHERE id = 1");
    if (!meta.rowCount) return null;
    const campaigns = await this.pool.query("SELECT * FROM inventory_campaigns");
    const accounts = await this.pool.query("SELECT * FROM inventory_accounts");
    return {
      fetchedAt: meta.rows[0].fetched_at.toISOString(),
      campaigns: campaigns.rows.map(rowToCampaign),
      accounts: accounts.rows.map(rowToAccount),
    };
  }

  async replaceFindings(rows: Finding[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM findings");
      for (const row of rows) {
        await client.query(
          `INSERT INTO findings (kind, campaign_id, account_id, email, detail, at)
           VALUES ($1,$2,$3,$4,$5,NOW())`,
          [row.kind, row.campaignId ?? null, row.accountId ?? null, row.email ?? null, row.detail],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listFindings(): Promise<Finding[]> {
    const r = await this.pool.query("SELECT * FROM findings ORDER BY at DESC");
    return r.rows.map((row) => ({
      kind: row.kind,
      campaignId: row.campaign_id ?? undefined,
      accountId: row.account_id ?? undefined,
      email: row.email ?? undefined,
      detail: row.detail,
      at: row.at.toISOString(),
    }));
  }

  async logIntended(action: IntendedAction): Promise<IntendedAction> {
    const r = await this.pool.query(
      `INSERT INTO intended_actions
        (kind, campaign_id, account_id, email, payload, executed, shadowed, write_enabled, blocked_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, at`,
      [
        action.kind,
        action.campaignId ?? null,
        action.accountId ?? null,
        action.email ?? null,
        action.payload,
        action.executed,
        action.shadowed,
        action.writeEnabled,
        action.blockedReason ?? null,
      ],
    );
    return {
      ...action,
      id: r.rows[0].id,
      at: r.rows[0].at.toISOString(),
    };
  }

  async listIntended(since?: Date): Promise<IntendedAction[]> {
    const r = since
      ? await this.pool.query("SELECT * FROM intended_actions WHERE at >= $1 ORDER BY at DESC", [
          since,
        ])
      : await this.pool.query("SELECT * FROM intended_actions ORDER BY at DESC LIMIT 5000");
    return r.rows.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      kind: row.kind,
      campaignId: row.campaign_id ?? undefined,
      accountId: row.account_id ?? undefined,
      email: row.email ?? undefined,
      payload: row.payload,
      executed: row.executed,
      shadowed: row.shadowed,
      writeEnabled: row.write_enabled,
      blockedReason: row.blocked_reason ?? undefined,
    }));
  }

  async upsertScore(score: PlacementScore): Promise<void> {
    await this.pool.query(
      `INSERT INTO placement_scores
        (campaign_id, campaign_name, source, test_id, inbox_percent, scored_at,
         fleet_emails_scored, released_emails_ignored)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (campaign_id) DO UPDATE SET
         campaign_name = EXCLUDED.campaign_name, source = EXCLUDED.source,
         test_id = EXCLUDED.test_id, inbox_percent = EXCLUDED.inbox_percent,
         scored_at = EXCLUDED.scored_at, fleet_emails_scored = EXCLUDED.fleet_emails_scored,
         released_emails_ignored = EXCLUDED.released_emails_ignored`,
      [
        score.campaignId,
        score.campaignName ?? null,
        score.source,
        score.testId,
        score.inboxPercent,
        score.scoredAt,
        score.fleetEmailsScored,
        score.releasedEmailsIgnored,
      ],
    );
  }

  async listScores(): Promise<PlacementScore[]> {
    const r = await this.pool.query("SELECT * FROM placement_scores");
    return r.rows.map((row) => ({
      campaignId: row.campaign_id,
      campaignName: row.campaign_name ?? undefined,
      source: row.source,
      testId: row.test_id,
      inboxPercent: Number(row.inbox_percent),
      scoredAt: row.scored_at.toISOString(),
      fleetEmailsScored: row.fleet_emails_scored,
      releasedEmailsIgnored: row.released_emails_ignored,
    }));
  }

  async upsertSuspect(row: IsolationSuspect): Promise<void> {
    await this.pool.query(
      `INSERT INTO isolation_suspects (campaign_id, campaign_name, source, test_id, queued_at, evaluated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (campaign_id) DO UPDATE SET
         campaign_name = EXCLUDED.campaign_name, source = EXCLUDED.source,
         test_id = EXCLUDED.test_id, queued_at = EXCLUDED.queued_at,
         evaluated_at = EXCLUDED.evaluated_at`,
      [
        row.campaignId,
        row.campaignName ?? null,
        row.source,
        row.testId ?? null,
        row.queuedAt,
        row.evaluatedAt ?? null,
      ],
    );
  }

  async listSuspects(): Promise<IsolationSuspect[]> {
    const r = await this.pool.query("SELECT * FROM isolation_suspects");
    return r.rows.map((row) => ({
      campaignId: row.campaign_id,
      campaignName: row.campaign_name ?? undefined,
      source: row.source,
      testId: row.test_id ?? undefined,
      queuedAt: row.queued_at.toISOString(),
      evaluatedAt: row.evaluated_at ? row.evaluated_at.toISOString() : undefined,
    }));
  }

  async insertRun(run: IsolationRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO isolation_runs (id, campaign_id, verdict, reason, started_at, finished_at, teardown_started)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        run.id,
        run.campaignId,
        run.verdict,
        run.reason,
        run.startedAt,
        run.finishedAt ?? null,
        run.teardownStarted,
      ],
    );
  }

  async latestRun(campaignId: number): Promise<IsolationRun | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM isolation_runs WHERE campaign_id = $1 ORDER BY started_at DESC LIMIT 1",
      [campaignId],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      campaignId: row.campaign_id,
      verdict: row.verdict,
      reason: row.reason,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at ? row.finished_at.toISOString() : undefined,
      teardownStarted: row.teardown_started,
    };
  }

  async stampOk(stage: string, at = new Date()): Promise<void> {
    await this.pool.query(
      `INSERT INTO stage_health (stage, last_ok_at, consecutive_failures, updated_at)
       VALUES ($1,$2,0,NOW())
       ON CONFLICT (stage) DO UPDATE SET last_ok_at = EXCLUDED.last_ok_at,
         consecutive_failures = 0, in_flight_since = NULL, updated_at = NOW()`,
      [stage, at],
    );
  }

  async stampError(stage: string, error: string, at = new Date()): Promise<void> {
    await this.pool.query(
      `INSERT INTO stage_health (stage, last_error_at, last_error, consecutive_failures, updated_at)
       VALUES ($1,$2,$3,1,NOW())
       ON CONFLICT (stage) DO UPDATE SET last_error_at = EXCLUDED.last_error_at,
         last_error = EXCLUDED.last_error,
         consecutive_failures = stage_health.consecutive_failures + 1,
         in_flight_since = NULL, updated_at = NOW()`,
      [stage, at, error],
    );
  }

  async listStamps(): Promise<StageStamp[]> {
    const r = await this.pool.query("SELECT * FROM stage_health");
    return r.rows.map((row) => ({
      stage: row.stage,
      lastOkAt: row.last_ok_at ? row.last_ok_at.toISOString() : undefined,
      lastErrorAt: row.last_error_at ? row.last_error_at.toISOString() : undefined,
      lastError: row.last_error ?? undefined,
      consecutiveFailures: row.consecutive_failures,
      inFlightSince: row.in_flight_since ? row.in_flight_since.toISOString() : undefined,
    }));
  }

  async upsertGeneric(seat: GenericSeat): Promise<void> {
    await this.pool.query(
      `INSERT INTO generic_seats (account_id, email, assigned_client_id, assigned_pod, assigned_at, released_at, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (account_id) DO UPDATE SET
         email = EXCLUDED.email, assigned_client_id = EXCLUDED.assigned_client_id,
         assigned_pod = EXCLUDED.assigned_pod, assigned_at = EXCLUDED.assigned_at,
         released_at = EXCLUDED.released_at, reason = EXCLUDED.reason`,
      [
        seat.accountId,
        seat.email,
        seat.assignedClientId,
        seat.assignedPod,
        seat.assignedAt,
        seat.releasedAt,
        seat.reason,
      ],
    );
  }

  async listGenerics(): Promise<GenericSeat[]> {
    const r = await this.pool.query("SELECT * FROM generic_seats");
    return r.rows.map((row) => ({
      accountId: row.account_id,
      email: row.email,
      assignedClientId: row.assigned_client_id,
      assignedPod: row.assigned_pod,
      assignedAt: row.assigned_at ? row.assigned_at.toISOString() : null,
      releasedAt: row.released_at ? row.released_at.toISOString() : null,
      reason: row.reason,
    }));
  }

  async saveComparison(report: unknown): Promise<void> {
    await this.pool.query("INSERT INTO comparison_reports (report) VALUES ($1)", [report]);
  }
}

function rowToCampaign(row: pg.QueryResultRow): SlimCampaign {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    clientId: row.client_id,
    minTimeBtwnEmails: row.min_time_btwn_emails,
  };
}

function rowToAccount(row: pg.QueryResultRow): SlimAccount {
  return {
    id: row.id,
    email: row.email,
    fromName: row.from_name ?? "",
    clientId: row.client_id,
    campaignIds: row.campaign_ids ?? [],
    tags: row.tags ?? [],
    smtpOk: row.smtp_ok !== false,
    imapOk: row.imap_ok !== false,
    messagePerDay: row.message_per_day,
    warmupBlocked: Boolean(row.warmup_blocked),
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    warmupStartedAt: row.warmup_started_at ? row.warmup_started_at.toISOString() : null,
    signature: row.signature ?? "",
  };
}
