#!/usr/bin/env python3
"""Patch public/demo/data.json for the video board.

- Backfill Positive / Interested from lead-category truth (Supabase mirror)
- Restore offer wording (tickets / Air Pods / Astros / flood zones)
- Redact client brand signatures (Mid-South / Nieto Technology Partners)
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "demo" / "data.json"

# From campaignintelligence.public.leads (2026-08-31)
POSITIVE = {
    3110622: 0,
    3201244: 0,
    3201308: 0,
    3201381: 0,
    3429214: 0,
    3429333: 0,
    3437329: 1,
    3563069: 21,
    3628940: 0,
    3628943: 0,
}
INTERESTED = {
    3110622: 0,
    3201244: 1,
    3201308: 1,
    3201381: 1,
    3429214: 2,
    3429333: 0,
    3437329: 0,
    3563069: 6,
    3628940: 13,
    3628943: 0,
}

SIG_BRANDS = [
    "Mid-South Roof Systems",
    "Mid-South Roofing",
    "Nieto Technology Partners",
    "Nieto Tech Partners",
]

# Team / venue names that precede a redacted "tickets"
TEAM = (
    r"(?:Wolfpack|Tar Heels?|Astros|Commodores|Crimson Tide|Demon Deacons|"
    r"Gamecocks|Grizzlies|Knicks|Panthers|Lookouts|RiverDogs|River Dogs)"
)

OFFER_FIXES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"Client A · █+zones", re.I), "Client A · Floodzones"),
    (re.compile(r"\b█+zones\b", re.I), "Floodzones"),
    (re.compile(r"top-10\s+█+\s+zone", re.I), "top-10 flood zone"),
    (re.compile(r"brand new set of █+\s*4", re.I), "brand new set of AirPods 4"),
    (re.compile(r"set of █+\s*4", re.I), "set of AirPods 4"),
    (re.compile(r"pair of █+\s*█+", re.I), "pair of tickets"),
    (re.compile(r"couple(?: of)? █+\s*█+", re.I), "couple tickets"),
    (re.compile(r"few (?:spare |extra )?█+\s*█*", re.I), "few spare tickets"),
    (re.compile(r"extra █+\s*█*", re.I), "extra tickets"),
    (re.compile(r"spare █+", re.I), "spare tickets"),
    (re.compile(rf"\b({TEAM})\s+█+", re.I), r"\1 tickets"),
    (re.compile(r"interested in the █+\s*█*", re.I), "interested in the tickets"),
    (re.compile(r"date of the █+", re.I), "date of the tickets"),
    (re.compile(r"█+\s+still stand", re.I), "tickets still stand"),
    (re.compile(r"generous offer of the █+\s*█*", re.I), "generous offer of the tickets"),
    (re.compile(r"offer of the █+\s*█*", re.I), "offer of the tickets"),
    (re.compile(r"offer for the █+", re.I), "offer for the tickets"),
    (re.compile(r"claiming the █+", re.I), "claiming the tickets"),
    (re.compile(r"take the █+", re.I), "take the tickets"),
    (re.compile(r"love the █+", re.I), "love the tickets"),
    (re.compile(r"accept the █+", re.I), "accept the tickets"),
    (re.compile(r"receive (?:the )?█+", re.I), "receive the tickets"),
    (re.compile(r"receiving the █+", re.I), "receiving the tickets"),
    (re.compile(r"send the █+", re.I), "send the tickets"),
    (re.compile(r"giving █+\s*█*", re.I), "giving tickets"),
    (re.compile(r"the █+\s+are still yours", re.I), "the tickets are still yours"),
    (re.compile(r"█+\s+are still yours", re.I), "tickets are still yours"),
    (re.compile(r"█+\s+are yours", re.I), "tickets are yours"),
    (re.compile(r"P\.S\.\s*█+\s+are yours", re.I), "P.S. tickets are yours"),
    (re.compile(r"█+\s+█+\s*[—\-–]\s*on me", re.I), "tickets — on me"),
    (re.compile(r"█+\s+█+\s+on me", re.I), "tickets on me"),
    (re.compile(r"as far as the █+\s+go", re.I), "as far as the tickets go"),
    (re.compile(r"No █+,\s*no resets", re.I), "No tickets, no resets"),
    (re.compile(r"No █+\s+necessary", re.I), "No tickets necessary"),
    (re.compile(r"\ba █+\s+game\b", re.I), "an Astros game"),
    (re.compile(r"Subject:\s*█+\s*█*", re.I), "Subject: tickets"),
    (re.compile(r"RE:\s*extra █+", re.I), "RE: extra tickets"),
    (re.compile(r"RE:\s*█+\s*█*", re.I), "RE: tickets"),
    (re.compile(rf"Subject:\s*({TEAM})\s+█+", re.I), r"Subject: \1 tickets"),
    (re.compile(rf"RE:\s*({TEAM})\s+█+", re.I), r"RE: \1 tickets"),
    (re.compile(rf"\b({TEAM})\s+█+", re.I), r"\1 tickets"),
    (re.compile(r"what day are the █+\s*█*", re.I), "what day are the tickets"),
]


def restore_offers(text: str, campaign_name: str = "") -> str:
    if not text:
        return text
    out = text
    airpods = "airpod" in campaign_name.lower() or "merch" in campaign_name.lower()
    for rx, repl in OFFER_FIXES:
        use = repl
        if airpods and "ticket" in repl.lower() and "Air" not in repl:
            use = (
                repl.replace("tickets", "Air Pods")
                .replace("ticket", "Air Pod")
                .replace("an Astros game", "Air Pods")
            )
        out = rx.sub(use, out)
    return out


def redact_signatures(text: str) -> str:
    if not text:
        return text
    out = text
    for brand in SIG_BRANDS:
        out = re.sub(re.escape(brand), "█" * len(brand), out, flags=re.I)
    # Bare client shorthand / partially redacted brand lines
    out = re.sub(r"\bMid-South\b", "█████████", out, flags=re.I)
    out = re.sub(r"\bNieto\b", "█████", out, flags=re.I)
    out = re.sub(
        r"█+\s*Technology Partners",
        "█" * len("Nieto Technology Partners"),
        out,
        flags=re.I,
    )
    return out


def walk_text(obj, campaign_name: str = "") -> None:
    if isinstance(obj, dict):
        name = obj.get("campaignName") or obj.get("name") or campaign_name
        for k, v in list(obj.items()):
            if k in ("body", "subject") and isinstance(v, str):
                # Subjects stay fully blurred in the UI; still restore offer
                # words inside quoted reply bodies.
                v2 = restore_offers(v, name)
                v2 = redact_signatures(v2)
                obj[k] = v2
            else:
                walk_text(v, name)
    elif isinstance(obj, list):
        for item in obj:
            walk_text(item, campaign_name)


def main() -> None:
    data = json.loads(DATA.read_text())
    for c in data.get("campaigns", []):
        oid = int(c["oldId"])
        pos = POSITIVE.get(oid, c.get("positive") or 0)
        interested = INTERESTED.get(oid, 0)
        c["positive"] = int(pos)
        c["interested"] = int(interested)
        cats = dict(c.get("categories") or {})
        if pos:
            cats["Positive Reply"] = int(pos)
        if interested:
            cats["Interested"] = int(interested)
        c["categories"] = cats
        c["name"] = restore_offers(c.get("name") or "", c.get("name") or "")

    walk_text(data)
    data["note"] = (
        "Real threads from the pre-delete mirror. Prospect emails and client "
        "signatures are redacted; offer wording is shown. Positive / Interested "
        "counts are backfilled from the lead-category mirror."
    )
    DATA.write_text(json.dumps(data, indent=2) + "\n")
    camps = data["campaigns"]
    print(
        "patched",
        DATA,
        "positive=",
        sum(c["positive"] for c in camps),
        "interested=",
        sum(c.get("interested", 0) for c in camps),
    )


if __name__ == "__main__":
    main()
