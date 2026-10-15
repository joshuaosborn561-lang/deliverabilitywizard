import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { randomUUID } from "node:crypto";
import type {
  EspInboxDay,
  Finding,
  GenericSeat,
  IntendedAction,
  InventoryBook,
  IsolationRun,
  IsolationSuspect,
  PlacementScore,
  QaRun,
  SeatHold,
  SlimAccount,
  SlimCampaign,
  StageStamp,
  TerlSubstitution,
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
  recordEspMatrix(row: EspInboxDay): Promise<void>;
  listEspMatrix(sinceDay?: string): Promise<EspInboxDay[]>;
  acquireQaLease(holder: string, ttlMs: number, now?: Date): Promise<{ acquired: boolean; token?: string }>;
  releaseQaLease(holder: string, token: string): Promise<void>;
  insertQaRun(run: QaRun): Promise<QaRun>;
  completeQaRun(id: string, patch: Partial<QaRun>): Promise<void>;
  listQaRuns(): Promise<QaRun[]>;
  upsertHold(hold: SeatHold): Promise<void>;
  listHolds(): Promise<SeatHold[]>;
  upsertTerlSub(row: TerlSubstitution): Promise<void>;
  listTerlSubs(): Promise<TerlSubstitution[]>;
  acquireRateSlot(maxInflight: number, maxPerMin: number): Promise<boolean>;
  releaseRateSlot(): Promise<void>;
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
  espDays: EspInboxDay[] = [];
  qaRuns: QaRun[] = [];
  qaLease: { holder: string; token: string; expiresAt: number } | null = null;
  holds: SeatHold[] = [];
  terlSubs: TerlSubstitution[] = [];
  rate: { windowStart: number; tokens: number; inflight: number } = {
    windowStart: Date.now(),
    tokens: 0,
    inflight: 0,
  };

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
    this.scores = this.scores.filter(
      (s) => !(s.campaignId === score.campaignId && s.source === score.source),
    );
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

  async recordEspMatrix(row: EspInboxDay): Promise<void> {
    this.espDays = this.espDays.filter(
      (r) => !(r.campaignId === row.campaignId && r.day === row.day),
    );
    this.espDays.push(row);
  }
  async listEspMatrix(sinceDay?: string): Promise<EspInboxDay[]> {
    if (!sinceDay) return [...this.espDays];
    return this.espDays.filter((r) => r.day >= sinceDay);
  }

  async acquireQaLease(
    holder: string,
    ttlMs: number,
    now = new Date(),
  ): Promise<{ acquired: boolean; token?: string }> {
    const t = now.getTime();
    if (this.qaLease && this.qaLease.expiresAt > t && this.qaLease.holder !== holder) {
      return { acquired: false };
    }
    const token = randomUUID();
    this.qaLease = { holder, token, expiresAt: t + ttlMs };
    return { acquired: true, token };
  }
  async releaseQaLease(holder: string, token: string): Promise<void> {
    if (this.qaLease?.holder === holder && this.qaLease.token === token) {
      this.qaLease = null;
    }
  }
  async insertQaRun(run: QaRun): Promise<QaRun> {
    const row = { ...run, id: run.id || randomUUID() };
    this.qaRuns.push(row);
    return row;
  }
  async completeQaRun(id: string, patch: Partial<QaRun>): Promise<void> {
    this.qaRuns = this.qaRuns.map((r) => (r.id === id ? { ...r, ...patch } : r));
  }
  async listQaRuns(): Promise<QaRun[]> {
    return [...this.qaRuns];
  }

  async upsertHold(hold: SeatHold): Promise<void> {
    this.holds = this.holds.filter((h) => h.accountId !== hold.accountId);
    this.holds.push(hold);
  }
  async listHolds(): Promise<SeatHold[]> {
    return [...this.holds];
  }
  async upsertTerlSub(row: TerlSubstitution): Promise<void> {
    this.terlSubs = this.terlSubs.filter(
      (s) => !(s.campaignId === row.campaignId && s.stoppedAccountId === row.stoppedAccountId),
    );
    this.terlSubs.push(row);
  }
  async listTerlSubs(): Promise<TerlSubstitution[]> {
    return [...this.terlSubs];
  }

  async acquireRateSlot(maxInflight: number, maxPerMin: number): Promise<boolean> {
    const now = Date.now();
    if (now - this.rate.windowStart >= 60_000) {
      this.rate = { windowStart: now, tokens: 0, inflight: this.rate.inflight };
    }
    if (this.rate.inflight >= maxInflight) return false;
    if (this.rate.tokens >= maxPerMin) return false;
    this.rate.tokens += 1;
    this.rate.inflight += 1;
    return true;
  }
  async releaseRateSlot(): Promise<void> {
    this.rate.inflight = Math.max(0, this.rate.inflight - 1);
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
         fleet_emails_scored, released_emails_ignored, canary_kind, failure_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (campaign_id, source) DO UPDATE SET
         campaign_name = EXCLUDED.campaign_name,
         test_id = EXCLUDED.test_id, inbox_percent = EXCLUDED.inbox_percent,
         scored_at = EXCLUDED.scored_at, fleet_emails_scored = EXCLUDED.fleet_emails_scored,
         released_emails_ignored = EXCLUDED.released_emails_ignored,
         canary_kind = EXCLUDED.canary_kind, failure_class = EXCLUDED.failure_class`,
      [
        score.campaignId,
        score.campaignName ?? null,
        score.source,
        score.testId,
        score.inboxPercent,
        score.scoredAt,
        score.fleetEmailsScored,
        score.releasedEmailsIgnored,
        score.canaryKind ?? null,
        score.failureClass ?? null,
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
      canaryKind: row.canary_kind ?? undefined,
      failureClass: row.failure_class ?? undefined,
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

  async recordEspMatrix(row: EspInboxDay): Promise<void> {
    await this.pool.query(
      `INSERT INTO esp_inbox_rates
        (campaign_id, day, campaign_name, g_to_g, g_to_ms, ms_to_g, ms_to_ms, test_id, source, updated_at)
       VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6,$7,NOW())
       ON CONFLICT (campaign_id, day) DO UPDATE SET
         campaign_name = EXCLUDED.campaign_name, g_to_g = EXCLUDED.g_to_g,
         g_to_ms = NULL, ms_to_g = NULL, ms_to_ms = EXCLUDED.ms_to_ms,
         test_id = EXCLUDED.test_id, source = EXCLUDED.source, updated_at = NOW()`,
      [
        row.campaignId,
        row.day,
        row.campaignName ?? null,
        row.gToG,
        row.msToMs,
        row.testId ?? null,
        row.source ?? null,
      ],
    );
  }
  async listEspMatrix(sinceDay?: string): Promise<EspInboxDay[]> {
    const r = sinceDay
      ? await this.pool.query("SELECT * FROM esp_inbox_rates WHERE day >= $1 ORDER BY day DESC", [
          sinceDay,
        ])
      : await this.pool.query("SELECT * FROM esp_inbox_rates ORDER BY day DESC LIMIT 500");
    return r.rows.map((row) => ({
      campaignId: row.campaign_id,
      campaignName: row.campaign_name ?? undefined,
      day: String(row.day).slice(0, 10),
      gToG: row.g_to_g == null ? null : Number(row.g_to_g),
      msToMs: row.ms_to_ms == null ? null : Number(row.ms_to_ms),
      testId: row.test_id ?? undefined,
      source: row.source ?? undefined,
    }));
  }

  async acquireQaLease(
    holder: string,
    ttlMs: number,
    now = new Date(),
  ): Promise<{ acquired: boolean; token?: string }> {
    const token = randomUUID();
    const expires = new Date(now.getTime() + ttlMs);
    await this.pool.query("DELETE FROM qa_leases WHERE expires_at <= $1", [now]);
    const existing = await this.pool.query("SELECT holder, token FROM qa_leases WHERE name = 'qa'");
    if (existing.rowCount && existing.rows[0].holder !== holder) {
      return { acquired: false };
    }
    await this.pool.query(
      `INSERT INTO qa_leases (name, holder, token, expires_at)
       VALUES ('qa', $1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, token = EXCLUDED.token,
         expires_at = EXCLUDED.expires_at`,
      [holder, token, expires],
    );
    return { acquired: true, token };
  }
  async releaseQaLease(holder: string, token: string): Promise<void> {
    await this.pool.query("DELETE FROM qa_leases WHERE name = 'qa' AND holder = $1 AND token = $2", [
      holder,
      token,
    ]);
  }
  async insertQaRun(run: QaRun): Promise<QaRun> {
    const id = run.id || randomUUID();
    await this.pool.query(
      `INSERT INTO qa_runs (id, scheduled_at, started_at, completed_at, role, status, trigger, campaign_id, detail, findings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        run.scheduledAt,
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.role,
        run.status,
        run.trigger,
        run.campaignId ?? null,
        run.detail ?? null,
        JSON.stringify(run.findings ?? []),
      ],
    );
    return { ...run, id };
  }
  async completeQaRun(id: string, patch: Partial<QaRun>): Promise<void> {
    await this.pool.query(
      `UPDATE qa_runs SET
         started_at = COALESCE($2, started_at),
         completed_at = COALESCE($3, completed_at),
         status = COALESCE($4, status),
         role = COALESCE($5, role),
         detail = COALESCE($6, detail),
         findings = COALESCE($7, findings)
       WHERE id = $1`,
      [
        id,
        patch.startedAt ?? null,
        patch.completedAt ?? null,
        patch.status ?? null,
        patch.role ?? null,
        patch.detail ?? null,
        patch.findings ? JSON.stringify(patch.findings) : null,
      ],
    );
  }
  async listQaRuns(): Promise<QaRun[]> {
    const r = await this.pool.query("SELECT * FROM qa_runs ORDER BY scheduled_at DESC LIMIT 500");
    return r.rows.map((row) => ({
      id: row.id,
      scheduledAt: row.scheduled_at.toISOString(),
      startedAt: row.started_at ? row.started_at.toISOString() : undefined,
      completedAt: row.completed_at ? row.completed_at.toISOString() : undefined,
      role: row.role,
      status: row.status,
      trigger: row.trigger,
      campaignId: row.campaign_id ?? undefined,
      detail: row.detail ?? undefined,
      findings: row.findings ?? [],
    }));
  }

  async upsertHold(hold: SeatHold): Promise<void> {
    await this.pool.query(
      `INSERT INTO holds (account_id, email, reason, evidence, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (account_id) DO UPDATE SET
         email = EXCLUDED.email, reason = EXCLUDED.reason, evidence = EXCLUDED.evidence,
         expires_at = EXCLUDED.expires_at`,
      [hold.accountId, hold.email, hold.reason, hold.evidence, hold.expiresAt, hold.createdAt],
    );
  }
  async listHolds(): Promise<SeatHold[]> {
    const r = await this.pool.query("SELECT * FROM holds");
    return r.rows.map((row) => ({
      accountId: row.account_id,
      email: row.email,
      reason: row.reason,
      evidence: row.evidence,
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    }));
  }
  async upsertTerlSub(row: TerlSubstitution): Promise<void> {
    await this.pool.query(
      `INSERT INTO terl_substitutions
        (campaign_id, stopped_account_id, stopped_email, substitute_account_id, substitute_email,
         client_id, tenant, stopped_at, restore_after, restored_at, no_substitute)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (campaign_id, stopped_account_id) DO UPDATE SET
         stopped_email = EXCLUDED.stopped_email,
         substitute_account_id = EXCLUDED.substitute_account_id,
         substitute_email = EXCLUDED.substitute_email,
         restored_at = EXCLUDED.restored_at,
         no_substitute = EXCLUDED.no_substitute,
         restore_after = EXCLUDED.restore_after`,
      [
        row.campaignId,
        row.stoppedAccountId,
        row.stoppedEmail,
        row.substituteAccountId,
        row.substituteEmail,
        row.clientId,
        row.tenant,
        row.stoppedAt,
        row.restoreAfter,
        row.restoredAt,
        row.noSubstitute,
      ],
    );
  }
  async listTerlSubs(): Promise<TerlSubstitution[]> {
    const r = await this.pool.query("SELECT * FROM terl_substitutions");
    return r.rows.map((row) => ({
      campaignId: row.campaign_id,
      stoppedAccountId: row.stopped_account_id,
      stoppedEmail: row.stopped_email,
      substituteAccountId: row.substitute_account_id,
      substituteEmail: row.substitute_email,
      clientId: row.client_id,
      tenant: row.tenant,
      stoppedAt: row.stopped_at.toISOString(),
      restoreAfter: row.restore_after.toISOString(),
      restoredAt: row.restored_at ? row.restored_at.toISOString() : null,
      noSubstitute: row.no_substitute,
    }));
  }

  async acquireRateSlot(maxInflight: number, maxPerMin: number): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE smartlead_limiter SET
         window_start = CASE WHEN NOW() - window_start >= interval '60 seconds' THEN NOW() ELSE window_start END,
         tokens_used = CASE WHEN NOW() - window_start >= interval '60 seconds' THEN 1 ELSE tokens_used + 1 END,
         inflight = CASE WHEN NOW() - window_start >= interval '60 seconds' THEN 1 ELSE inflight + 1 END
       WHERE id = 1
         AND inflight < $1
         AND (
           NOW() - window_start >= interval '60 seconds'
           OR tokens_used < $2
         )
       RETURNING id`,
      [maxInflight, maxPerMin],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async releaseRateSlot(): Promise<void> {
    await this.pool.query(
      "UPDATE smartlead_limiter SET inflight = GREATEST(inflight - 1, 0) WHERE id = 1",
    );
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
