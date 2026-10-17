/**
 * D286 — optional upsert-only mirror of the generics ledger.
 * Wizard `state.genericSeats` stays source of truth. Writes
 * `wizard.generic_ledger` when Supabase env is present.
 * Does not invent keys.
 */

import type { GenericSeatRecord } from "./genericPool.js";

export const GENERIC_LEDGER_TABLE = "wizard.generic_ledger";

export interface GenericLedgerSupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

export function readGenericLedgerSupabaseEnv(
  env: NodeJS.ProcessEnv = process.env,
): GenericLedgerSupabaseConfig | null {
  const enabledRaw = String(env.GENERIC_LEDGER_SUPABASE ?? "").trim().toLowerCase();
  const url = String(env.SUPABASE_URL ?? env.GENERIC_LEDGER_SUPABASE_URL ?? "").trim();
  const key = String(
    env.SUPABASE_SERVICE_ROLE_KEY ??
      env.SUPABASE_SERVICE_KEY ??
      env.GENERIC_LEDGER_SUPABASE_KEY ??
      "",
  ).trim();
  if (enabledRaw === "0" || enabledRaw === "false" || enabledRaw === "off") {
    return null;
  }
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), serviceRoleKey: key };
}

export function genericLedgerSupabaseNeeded(): string[] {
  return [
    "SUPABASE_URL (project URL)",
    "SUPABASE_SERVICE_ROLE_KEY (service role; upsert-only to wizard.generic_ledger)",
    "optional GENERIC_LEDGER_SUPABASE=1 to force-enable once keys exist",
  ];
}

export interface GenericLedgerRow {
  email: string;
  sl_account_id: number | null;
  esp: string;
  warmup_enabled: boolean | null;
  assigned_client_id: number | null;
  assigned_pod: string | null;
  assigned_at: string | null;
  covering_for: Array<{ email: string; warm_ready_at: string | null }>;
  excluded: boolean;
  updated_at: string;
}

export function genericSeatToLedgerRow(
  seat: GenericSeatRecord,
  now = new Date(),
): GenericLedgerRow {
  return {
    email: seat.email,
    sl_account_id: seat.slAccountId,
    esp: seat.provider,
    warmup_enabled: seat.warmupEnabled,
    assigned_client_id: seat.assignedClientId,
    assigned_pod: seat.assignedPod,
    assigned_at: seat.assignedAt,
    covering_for: (seat.coveringFor ?? []).map((row) => ({
      email: row.email,
      warm_ready_at: row.warmReadyAt,
    })),
    excluded: Boolean(seat.excluded),
    updated_at: now.toISOString(),
  };
}

export async function upsertGenericLedgerToSupabase(input: {
  seats: GenericSeatRecord[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<{
  skipped: boolean;
  reason?: string;
  upserted: number;
  error?: string;
}> {
  const creds = readGenericLedgerSupabaseEnv(input.env ?? process.env);
  if (!creds) {
    return {
      skipped: true,
      reason: "no_supabase_credentials",
      upserted: 0,
    };
  }
  const rows = input.seats.map((seat) =>
    genericSeatToLedgerRow(seat, input.now),
  );
  if (!rows.length) return { skipped: false, upserted: 0 };
  const fetchFn = input.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(
      `${creds.url}/rest/v1/generic_ledger?on_conflict=email`,
      {
        method: "POST",
        headers: {
          apikey: creds.serviceRoleKey,
          Authorization: `Bearer ${creds.serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
          "Content-Profile": "wizard",
          "Accept-Profile": "wizard",
        },
        body: JSON.stringify(rows),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        skipped: false,
        upserted: 0,
        error: `supabase ${res.status} ${body.slice(0, 200)}`,
      };
    }
    return { skipped: false, upserted: rows.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { skipped: false, upserted: 0, error: message };
  }
}
