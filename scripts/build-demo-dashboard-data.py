#!/usr/bin/env python3
"""Rebuild public/demo/data.json from Supabase MCP dump files.

Usage (after saving execute_sql outputs under /tmp or agent-tools):

  python3 scripts/build-demo-dashboard-data.py \\
    --messages /path/to/messages-mcp.json \\
    --examples /path/to/examples-mcp.json

Or with default paths written by the last agent dump.
"""

from __future__ import annotations

import argparse
import html as htmlmod
import json
import re
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "demo" / "data.json"
LEADS = ROOT / "data" / "old-client-restore" / "leads.json"

RESTORE = {
    3110622: 3867914,
    3201244: 3867917,
    3201308: 3867918,
    3201381: 3867919,
    3429214: 3867921,
    3429333: 3867922,
    3437329: 3867923,
    3563069: 3867925,
    3628940: 3867944,
    3628943: 3867945,
}

ANALYTICS = [
    {"oldId": 3110622, "newId": 3867914, "name": "Nieto RB2B", "sent": 133, "replied": 0, "positive": 0, "bounced": 14, "status": "COMPLETED"},
    {"oldId": 3201244, "newId": 3867917, "name": "Nieto Houston Floodzones", "sent": 1318, "replied": 10, "positive": 0, "bounced": 14, "status": "COMPLETED"},
    {"oldId": 3201308, "newId": 3867918, "name": "Nieto MSPs 20-200", "sent": 26956, "replied": 295, "positive": 0, "bounced": 157, "status": "COMPLETED"},
    {"oldId": 3201381, "newId": 3867919, "name": "Nieto Spring", "sent": 3602, "replied": 64, "positive": 0, "bounced": 56, "status": "COMPLETED"},
    {"oldId": 3429214, "newId": 3867921, "name": "Nieto Law Firms", "sent": 2238, "replied": 36, "positive": 0, "bounced": 59, "status": "COMPLETED"},
    {"oldId": 3429333, "newId": 3867922, "name": "Nieto Baseball Offer", "sent": 1740, "replied": 28, "positive": 0, "bounced": 33, "status": "COMPLETED"},
    {"oldId": 3437329, "newId": 3867923, "name": "Nieto Sports / Merch Offer", "sent": 4031, "replied": 31, "positive": 1, "bounced": 99, "status": "COMPLETED"},
    {"oldId": 3563069, "newId": 3867925, "name": "MSRS Ticket Offer", "sent": 5592, "replied": 183, "positive": 22, "bounced": 39, "status": "COMPLETED"},
    {"oldId": 3628940, "newId": 3867944, "name": "MSRS2 Ticket Offer", "sent": 5108, "replied": 101, "positive": 0, "bounced": 124, "status": "COMPLETED"},
    {"oldId": 3628943, "newId": 3867945, "name": "Positive", "sent": 0, "replied": 0, "positive": 0, "bounced": 0, "status": "DRAFTED"},
]


class Stripper(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip = False

    def handle_starttag(self, tag, attrs):  # noqa: ANN001
        if tag in ("script", "style"):
            self.skip = True
        if tag in ("br", "p", "div", "tr", "li", "h1", "h2", "h3"):
            self.parts.append("\n")

    def handle_endtag(self, tag):  # noqa: ANN001
        if tag in ("script", "style"):
            self.skip = False

    def handle_data(self, data):  # noqa: ANN001
        if not self.skip:
            self.parts.append(data)


EMAIL_RE = re.compile(r"\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b", re.I)
PHONE_RE = re.compile(r"\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b")
URL_RE = re.compile(r"https?://[^\s<>\"]+", re.I)
OFFER_RE = re.compile(
    r"air\s*pods?|"
    r"sports?\s+tickets?|"
    r"(?:complimentary|free|vip|suite|box)\s+tickets?|"
    r"ticket\s+offer|"
    r"(?:astros|world\s*series)\b|"
    r"(?:nba|nfl|mlb)\s+tickets?|"
    r"flood\s*zones?|"
    r"houston\s+flood|"
    r"tickets?\s+to\s+(?:the\s+)?(?:game|astros|match)|"
    r"\b(?:airpods?|tickets?)\b",
    re.I,
)


def load_mcp(path: Path) -> list:
    outer = json.loads(path.read_text())
    text = outer["result"] if isinstance(outer, dict) else outer
    m = re.search(
        r"<untrusted-data-[^>]+>\s*(\[.*\])\s*</untrusted-data-[^>]+>",
        text,
        re.S,
    )
    if not m:
        raise SystemExit(f"no untrusted JSON array in {path}")
    return json.loads(m.group(1))


def html_to_text(s: str) -> str:
    if not s:
        return ""
    p = Stripper()
    try:
        p.feed(s)
    except Exception:
        return re.sub(r"<[^>]+>", " ", s)
    text = htmlmod.unescape("".join(p.parts))
    text = re.sub(r"\r", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def mask_email(e: str) -> str:
    e = (e or "").strip()
    if not e:
        return ""
    if "@" not in e:
        return "••••"
    local, _, domain = e.partition("@")
    local_m = (local[:1] + "•" * max(3, len(local) - 1)) if local else "••••"
    parts = domain.split(".")
    if len(parts) >= 2:
        dom = "•" * max(3, len(parts[0])) + "." + parts[-1]
    else:
        dom = "••••.com"
    return f"{local_m}@{dom}"


def redact_text(text: str) -> str:
    if not text:
        return ""
    text = EMAIL_RE.sub(lambda m: mask_email(m.group(0)), text)
    text = PHONE_RE.sub("•••-•••-••••", text)
    text = URL_RE.sub("https://••••.com/••••", text)
    text = OFFER_RE.sub("████", text)
    return text


def first_name_only(fn: str | None, ln: str | None) -> str:
    fn = (fn or "").strip()
    ln = (ln or "").strip()
    if fn:
        return fn.title()
    if ln:
        return ln[0].upper() + "."
    return "Prospect"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--messages", type=Path, required=True)
    ap.add_argument("--examples", type=Path, required=True)
    args = ap.parse_args()

    msgs = load_mcp(args.messages)
    examples = load_mcp(args.examples)
    name_by_old = {a["oldId"]: a["name"] for a in ANALYTICS}
    keep = {
        "Positive Reply",
        "Interested",
        "Meeting Request",
        "Information Request",
        "MEETING_PROPOSED",
    }

    replies: list[dict] = []
    seen: set = set()
    for m in msgs:
        if (m.get("category") or "") not in keep:
            continue
        body = html_to_text(m.get("body") or "")
        if len(body) < 8:
            continue
        low = body.lower()
        if ("out of office" in low or "out of the office" in low) and m.get(
            "category",
        ) != "Positive Reply" and len(body) < 500:
            continue
        key = (m["old_campaign_id"], (m.get("lead_email") or "").lower(), body[:120])
        if key in seen:
            continue
        seen.add(key)
        replies.append(
            {
                "campaignOldId": m["old_campaign_id"],
                "campaignNewId": RESTORE.get(m["old_campaign_id"]),
                "campaignName": name_by_old.get(
                    m["old_campaign_id"],
                    m["campaign_name"],
                ),
                "category": m.get("category") or "Reply",
                "fromName": first_name_only(m.get("first_name"), m.get("last_name")),
                "fromEmailMasked": mask_email(m.get("lead_email") or ""),
                "company": (m.get("company") or "").strip() or None,
                "subject": redact_text(
                    html_to_text(m.get("subject") or "") or "(no subject)",
                ),
                "body": redact_text(body)[:1800],
                "at": m.get("at"),
            },
        )

    for ex in examples:
        cat = ex.get("category") or ""
        if cat == "MEETING_PROPOSED":
            cat = "Meeting Request"
        if cat not in keep:
            continue
        body = html_to_text(ex.get("lead_message") or "")
        if len(body) < 8:
            continue
        key = ("ex", body[:120])
        if key in seen:
            continue
        seen.add(key)
        cn = ex.get("client_name") or ""
        old = 3563069 if "MSRS" in cn else (3201308 if "Nieto" in cn else None)
        replies.append(
            {
                "campaignOldId": old,
                "campaignNewId": RESTORE.get(old) if old else None,
                "campaignName": name_by_old.get(old, cn or "Reply examples")
                if old
                else (cn or "Reply examples"),
                "category": cat,
                "fromName": "Prospect",
                "fromEmailMasked": "p••••@••••.com",
                "company": None,
                "subject": "Re: outreach",
                "body": redact_text(body)[:1800],
                "at": ex.get("created_at"),
            },
        )

    rank = {
        "Positive Reply": 0,
        "Meeting Request": 1,
        "Interested": 2,
        "Information Request": 3,
    }
    buckets: dict[int, list] = {k: [] for k in range(5)}
    for r in replies:
        buckets[rank.get(r["category"], 4)].append(r)
    ordered: list[dict] = []
    for k in sorted(buckets):
        ordered.extend(
            sorted(buckets[k], key=lambda r: r.get("at") or "", reverse=True),
        )

    analytics = [dict(a) for a in ANALYTICS]
    if LEADS.exists():
        leads = json.loads(LEADS.read_text())
        lead_counts = Counter(l["smartlead_campaign_id"] for l in leads)
        cat_counts: dict[int, Counter] = {}
        for l in leads:
            cat = (l.get("category") or "").strip()
            if not cat:
                continue
            cat_counts.setdefault(l["smartlead_campaign_id"], Counter())[cat] += 1
        for a in analytics:
            a["leads"] = int(lead_counts.get(a["oldId"], 0))
            a["categories"] = {
                k: int(v) for k, v in cat_counts.get(a["oldId"], {}).items()
            }

    out = {
        "title": "Campaign restore demo",
        "note": "Real reply text from the pre-delete mirror. Prospect emails, phones, links, and offer terms (████) are redacted for the recording.",
        "campaigns": analytics,
        "replies": ordered,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {OUT} replies={len(ordered)}")


if __name__ == "__main__":
    main()
