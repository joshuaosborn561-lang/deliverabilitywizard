# Old-client restore (D144)

Supabase mirror dump used to recreate the Nieto / MSRS / Positive
campaigns Smartlead permanently deleted on 2026-08-26.

| File | Purpose |
|---|---|
| `campaigns.json` | Names + sequences (committed) |
| `leads.json` | 18,318 lead emails (gitignored — re-export from Supabase) |
| `restore-map.json` | old Smartlead id → new id after apply (gitignored) |

## Video demo UI

`/demo` is a Smartlead-ish campaign board + reply inbox:

- Campaign sent / replied / positive / bounced from `ANALYTICS.md`
- Real inbound reply bodies from Supabase `messages` / `reply_examples`
- Prospect emails, phones, links, and offer terms (airpods / tickets /
  Astros / etc.) redacted to `••••` / `████` in `public/demo/data.json`

Open **https://deliverabilitywizard-production.up.railway.app/demo** after deploy.
Local preview without Railway: `python3 -m http.server --directory public/demo`.

Rebuild data after a fresh dump:

```bash
python3 scripts/build-demo-dashboard-data.py \
  --messages /path/to/messages-mcp.json \
  --examples /path/to/examples-mcp.json
```

```bash
# After D144 is on main (teardown gone):
unset RAILWAY_TOKEN RAILWAY_API_TOKEN   # bad injected token breaks railway run
railway run -- npx tsx scripts/restore-old-clients.ts          # dry-run
railway run -- npx tsx scripts/restore-old-clients.ts --apply  # create + sequences + PAUSE
railway run -- npx tsx scripts/restore-old-clients.ts --apply --leads
railway run -- npx tsx scripts/restore-lead-categories.ts --apply  # Interested / Positive Reply / etc.
```

Category writes move the lead-stats panel. Campaign header **sent**
cannot be restored — see `ANALYTICS.md`.

Never START from this script (D40).
