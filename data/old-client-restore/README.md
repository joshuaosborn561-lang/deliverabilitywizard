# Old-client restore (D144)

Supabase mirror dump used to recreate the Nieto / MSRS / Positive
campaigns Smartlead permanently deleted on 2026-08-26.

| File | Purpose |
|---|---|
| `campaigns.json` | Names + sequences (committed) |
| `leads.json` | 18,318 lead emails (gitignored — re-export from Supabase) |
| `restore-map.json` | old Smartlead id → new id after apply (gitignored) |

```bash
# After D144 is on main (teardown gone):
railway run -- npx tsx scripts/restore-old-clients.ts          # dry-run
railway run -- npx tsx scripts/restore-old-clients.ts --apply  # create + sequences + PAUSE
railway run -- npx tsx scripts/restore-old-clients.ts --apply --leads
```

Never START from this script (D40).
