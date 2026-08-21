#!/usr/bin/env python3
"""Compare Smartlead sequence merge tags against a lead sample.

Exit 0 if every {{tag}} is a system field or a custom_fields key present
on enough sampled leads. Exit 1 (do not upload) otherwise.

Usage:
  python3 scripts/check_merge_tags.py sequences.json leads.json
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

SYSTEM_FIELDS = {
    "email",
    "first_name",
    "last_name",
    "company_name",
    "phone_number",
    "website",
    "location",
    "linkedin_profile",
    "company_url",
}

TAG_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
# A custom field must appear on at least this share of sampled leads.
MIN_CUSTOM_COVERAGE = 0.8


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def as_list(payload: Any, *keys: str) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            return value
    return []


def extract_bodies(sequences: Any) -> list[tuple[str, str]]:
    """Return (label, html) pairs from a sequences dump."""
    steps = as_list(sequences, "sequences", "data", "email_sequences")
    if not steps and isinstance(sequences, dict):
        steps = [sequences]
    out: list[tuple[str, str]] = []
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        step_id = step.get("id") or step.get("seq_number") or i + 1
        variants = as_list(step, "variants", "email_campaign_body")
        if variants:
            for j, variant in enumerate(variants):
                if isinstance(variant, str):
                    out.append((f"step {step_id} variant {j + 1}", variant))
                    continue
                if not isinstance(variant, dict):
                    continue
                body = (
                    variant.get("email_body")
                    or variant.get("body")
                    or variant.get("html")
                    or ""
                )
                label = variant.get("variant_label") or chr(ord("A") + j)
                out.append((f"step {step_id} variant {label}", str(body)))
            continue
        body = step.get("email_body") or step.get("body") or ""
        if body:
            out.append((f"step {step_id}", str(body)))
    return out


def extract_leads(leads: Any) -> list[dict[str, Any]]:
    rows = as_list(leads, "data", "leads", "results")
    return [row for row in rows if isinstance(row, dict)]


def custom_keys(lead: dict[str, Any]) -> set[str]:
    fields = lead.get("custom_fields")
    if isinstance(fields, dict):
        return {str(k) for k in fields.keys() if fields.get(k) not in (None, "")}
    return set()


def close_matches(tag: str, keys: set[str]) -> list[str]:
    needle = tag.lower().replace("_", "").replace(" ", "")
    hits = []
    for key in sorted(keys):
        compact = key.lower().replace("_", "").replace(" ", "")
        if needle == compact or needle in compact or compact in needle:
            hits.append(key)
    return hits[:5]


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: check_merge_tags.py sequences.json leads.json", file=sys.stderr)
        return 2
    sequences_path = Path(argv[1])
    leads_path = Path(argv[2])
    bodies = extract_bodies(load_json(sequences_path))
    leads = extract_leads(load_json(leads_path))
    if not bodies:
        print("FAIL: no sequence bodies found in", sequences_path)
        return 1
    if not leads:
        print("FAIL: no leads found in", leads_path, "(sample several offsets)")
        return 1

    all_custom: set[str] = set()
    coverage: dict[str, int] = {}
    for lead in leads:
        keys = custom_keys(lead)
        all_custom.update(keys)
        for key in keys:
            coverage[key] = coverage.get(key, 0) + 1

    failed = False
    seen: set[str] = set()
    for label, html in bodies:
        for tag in TAG_RE.findall(html):
            name = tag.strip()
            if name in seen:
                continue
            seen.add(name)
            if name in SYSTEM_FIELDS:
                continue
            if name in coverage:
                share = coverage[name] / len(leads)
                if share < MIN_CUSTOM_COVERAGE:
                    print(
                        f"FAIL: {{{{{name}}}}} is a real custom key but only "
                        f"{coverage[name]}/{len(leads)} sampled leads have a value "
                        f"({share:.0%} < {MIN_CUSTOM_COVERAGE:.0%}). "
                        f"First seen in {label}."
                    )
                    failed = True
                continue
            hint = close_matches(name, all_custom | SYSTEM_FIELDS)
            extra = f" Closest keys: {', '.join(hint)}." if hint else ""
            print(
                f"FAIL: {{{{{name}}}}} is not a system field and is absent from "
                f"sampled custom_fields. First seen in {label}.{extra}"
            )
            failed = True

    if failed:
        print(f"checked {len(bodies)} bodies against {len(leads)} leads")
        return 1
    print(
        f"ok: {len(seen)} tags across {len(bodies)} bodies, "
        f"{len(leads)} leads sampled"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
