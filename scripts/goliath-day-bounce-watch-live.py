#!/usr/bin/env python3
"""Live Goliath day-bounce watcher until the app deploy covers D38.

Polls Smartlead analytics-by-date for America/Chicago calendar day.
If bounced/sent > 7% with >=50 sends → pause campaign, Slack Cayden, diagnose.
"""
from __future__ import annotations

import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ssl._create_default_https_context = ssl._create_unverified_context

ENV_PATH = "/tmp/railway-prod.env"
WATCH_TZ = ZoneInfo("America/Chicago")
# Josh: watch TOMORROW's sends only — hard-lock to Aug 13 Chicago.
WATCH_DATE_ONLY = "2026-08-13"
THRESHOLD = 7.0
MIN_SENT = 50
POLL_SECS = 900  # 15 minutes
STATE_PATH = "/tmp/goliath-day-bounce-state.json"
GOLIATH_IDS = [3781908, 3781909, 3781910, 3781911, 3781912, 3781913, 3781914, 3781915]


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k] = v
    return env


def chicago_date() -> str:
    return datetime.now(WATCH_TZ).date().isoformat()


def watch_date() -> str:
    """Hard-locked to Josh's requested day; never act on a prior calendar day."""
    return WATCH_DATE_ONLY


def api_get(sl: str, path: str, params: dict) -> dict:
    q = urllib.parse.urlencode({**params, "api_key": sl})
    url = f"https://server.smartlead.ai/api/v1/{path}?{q}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def api_post(sl: str, path: str, body: dict) -> dict:
    url = f"https://server.smartlead.ai/api/v1/{path}?api_key={sl}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def slack_send(token: str, channel: str, text: str) -> None:
    payload = json.dumps({"channel": channel, "text": text}).encode()
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = json.loads(resp.read().decode())
        if not out.get("ok"):
            raise RuntimeError(f"slack: {out.get('error')}")


def load_state() -> dict:
    if not os.path.exists(STATE_PATH):
        return {"alerted": []}
    with open(STATE_PATH) as f:
        return json.load(f)


def save_state(state: dict) -> None:
    with open(STATE_PATH, "w") as f:
        json.dump(state, f)


def sibling_key(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"\b(tickets?|airpods?)\b", " ", name, flags=re.I)).strip().lower()


def diagnose(name: str, rate: float, siblings: list[dict], categories: dict[str, int]) -> tuple[str, list[str]]:
    reasons: list[str] = []
    votes: list[str] = []
    so = sum(v for k, v in categories.items() if re.search(r"sender\s*originated", k, re.I))
    total = sum(categories.values()) or 0
    if total and so / total >= 0.5:
        votes.append("delays")
        reasons.append(f"{round(so/total*100)}% of sampled bounces are Sender Originated Bounce (delays/reputation).")
    key = sibling_key(name)
    if re.search(r"airpods?", name, re.I):
        tickets = next((s for s in siblings if sibling_key(s["name"]) == key and re.search(r"tickets?", s["name"], re.I) and s["sent"] >= 30), None)
        if tickets and tickets["rate"] + 5 < rate:
            votes.append("copy")
            reasons.append(f"Sibling {tickets['name']} is only {tickets['rate']:.1f}% — AirPods offer/copy likely.")
    if re.search(r"airpods?", name, re.I):
        votes.append("copy")
        reasons.append("Campaign name/offer is AirPods — treat copy/spam words as a prime suspect.")
    if not votes:
        return "unclear", reasons or ["Need SMTP/list check — no single signal dominated."]
    if votes.count("copy") and votes.count("delays"):
        return "mixed (delays + copy)", reasons
    if "copy" in votes:
        return "spam words / offer copy", reasons
    if "delays" in votes:
        return "delays / sender reputation", reasons
    return "unclear", reasons


def bounce_categories(sl: str, cid: int, day: str) -> dict[str, int]:
    cats: dict[str, int] = {}
    start = f"{day}T00:00:00.000Z"
    end_dt = datetime.fromisoformat(day).replace(tzinfo=timezone.utc)
    # +1 day
    from datetime import timedelta

    end = (end_dt + timedelta(days=1)).isoformat().replace("+00:00", "Z")
    offset = 0
    for _ in range(4):
        try:
            page = api_get(
                sl,
                f"campaigns/{cid}/statistics",
                {
                    "email_status": "bounced",
                    "sent_time_start_date": start,
                    "sent_time_end_date": end,
                    "offset": offset,
                    "limit": 50,
                },
            )
        except Exception:
            break
        rows = page.get("data") or []
        if not rows:
            break
        for r in rows:
            c = r.get("lead_category") or "none"
            cats[c] = cats.get(c, 0) + 1
        offset += len(rows)
        if len(rows) < 50:
            break
        time.sleep(0.2)
    return cats


def once(env: dict[str, str], state: dict) -> None:
    sl = env["SMARTLEAD_API_KEY"]
    token = env["SLACK_BOT_TOKEN"]
    channel = env.get("SLACK_CHANNEL_ID") or env.get("SLACK_CHANNEL")
    day = watch_date()
    today = chicago_date()
    print(
        f"[{datetime.now(timezone.utc).isoformat()}] watch day={day} (chicago today={today})",
        flush=True,
    )
    if today < day:
        print("  before watch day — measuring only, no pauses until Aug 13 Chicago", flush=True)

    stats = []
    for cid in GOLIATH_IDS:
        try:
            d = api_get(sl, f"campaigns/{cid}/analytics-by-date", {"start_date": day, "end_date": day})
        except urllib.error.HTTPError as e:
            print(f"  #{cid} analytics fail {e.code}", flush=True)
            time.sleep(1)
            continue
        sent = int(d.get("sent_count") or 0)
        bounced = int(d.get("bounce_count") or 0)
        rate = (bounced * 100 / sent) if sent else 0.0
        name = d.get("name") or f"Campaign {cid}"
        status = d.get("status") or "?"
        stats.append({"id": cid, "name": name, "sent": sent, "bounced": bounced, "rate": rate, "status": status})
        print(f"  #{cid} [{status}] sent={sent} bounce={bounced} rate={rate:.1f}% {name}", flush=True)
        time.sleep(0.25)

    # Never pause/alert until the locked watch calendar day has started.
    if today < day:
        return

    for row in stats:
        if row["sent"] < MIN_SENT:
            continue
        if not (row["bounced"] * 100 > THRESHOLD * row["sent"]):
            continue
        key = f"{day}:{row['id']}"
        if key in state.get("alerted", []):
            print(f"  already alerted {key}", flush=True)
            continue

        paused = False
        if str(row["status"]).upper() == "ACTIVE":
            try:
                api_post(sl, f"campaigns/{row['id']}/status", {"status": "PAUSED"})
                paused = True
            except Exception as e:
                print(f"  pause fail #{row['id']}: {e}", flush=True)

        cats = bounce_categories(sl, row["id"], day)
        cause, reasons = diagnose(row["name"], row["rate"], stats, cats)
        text = "\n".join(
            [
                "*Cayden* — *Goliath day-bounce trip*",
                f"Campaign: *#{row['id']} {row['name']}*",
                f"Watch day: *{day}* (America/Chicago via analytics-by-date)",
                f"Day bounce: *{row['rate']:.1f}%* ({row['bounced']}/{row['sent']} sends) — threshold 7%",
                f"Action: *{'PAUSED' if paused else 'not paused (was not ACTIVE)'}*",
                "",
                f"*Likely cause:* {cause}",
                *[f"• {r}" for r in reasons],
                "",
                "_Live poller (pre-deploy). App PR wires this into health cron (D38)._",
            ]
        )
        try:
            slack_send(token, channel, text)
        except Exception as e:
            print(f"  slack fail: {e}", flush=True)
        state.setdefault("alerted", []).append(key)
        save_state(state)
        print(f"  TRIP #{row['id']} paused={paused} cause={cause}", flush=True)


def main() -> None:
    env = load_env()
    state = load_state()
    # Run until end of Chicago Aug 13 (or later if still useful through Aug 14 06:00 Chicago)
    end = datetime(2026, 8, 14, 6, 0, tzinfo=WATCH_TZ)
    # Clear any Aug-12 alert keys from the misfire so they cannot confuse Aug-13.
    state["alerted"] = [k for k in state.get("alerted", []) if k.startswith("2026-08-13:")]
    save_state(state)
    slack_send(
        env["SLACK_BOT_TOKEN"],
        env.get("SLACK_CHANNEL_ID") or env.get("SLACK_CHANNEL"),
        "*Goliath live poller online (Aug 13 only)* — every 15m; pause + ping Cayden if that day’s bounce goes over 7%.",
    )
    while datetime.now(WATCH_TZ) < end:
        try:
            once(env, state)
        except Exception as e:
            print(f"loop error: {e}", flush=True)
        time.sleep(POLL_SECS)
    print("watcher finished", flush=True)


if __name__ == "__main__":
    main()
