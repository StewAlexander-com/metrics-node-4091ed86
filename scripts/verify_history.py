#!/usr/bin/env python3
"""
Integrity check: rebuilds the derived views/clones series purely from the
append-only data/raw_log.jsonl (the permanent ground-truth evidence) and
diffs the result against the committed data/history.json.

This is the mechanism that makes the dashboard's numbers auditable rather
than just asserted: if this script reports "MATCH", every daily_views /
daily_clones number in history.json is provably a faithful merge of actual
GitHub API responses on record in raw_log.jsonl. If it reports drift, that
means either a bug in collect.py's merge logic or manual tampering with
history.json -- and this script says exactly where.

Usage: python3 scripts/verify_history.py
Exit code 0 = clean match. Exit code 1 = drift found (details printed).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HISTORY_PATH = os.path.join(HERE, "..", "data", "history.json")
RAW_LOG_PATH = os.path.join(HERE, "..", "data", "raw_log.jsonl")


def date_key(ts):
    return ts[:10]


def rebuild_from_raw_log():
    """Replays every raw_log.jsonl entry in order and reconstructs
    daily_views / daily_clones exactly the way collect.py's merge_series
    does: last-observed-value-wins per date, in chronological run order."""
    rebuilt = {}  # repo -> {"daily_views": {date: {...}}, "daily_clones": {...}}
    if not os.path.exists(RAW_LOG_PATH):
        return rebuilt

    with open(RAW_LOG_PATH) as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"WARNING: raw_log.jsonl line {line_no} is not valid JSON: {e}", file=sys.stderr)
                continue

            repo = entry.get("repo")
            endpoint = entry.get("endpoint")
            if repo == "__account__" or not entry.get("ok"):
                continue

            body = entry.get("body")
            rec = rebuilt.setdefault(repo, {"daily_views": {}, "daily_clones": {}})

            if endpoint == "traffic_views" and isinstance(body, dict) and "views" in body:
                for item in body["views"]:
                    d = date_key(item["timestamp"])
                    rec["daily_views"][d] = {"count": item.get("count", 0), "uniques": item.get("uniques", 0)}

            elif endpoint == "traffic_clones" and isinstance(body, dict) and "clones" in body:
                for item in body["clones"]:
                    d = date_key(item["timestamp"])
                    rec["daily_clones"][d] = {"count": item.get("count", 0), "uniques": item.get("uniques", 0)}

    return rebuilt


def main():
    if not os.path.exists(HISTORY_PATH):
        print("No history.json found -- nothing to verify.", file=sys.stderr)
        sys.exit(0)

    with open(HISTORY_PATH) as f:
        committed = json.load(f)

    rebuilt = rebuild_from_raw_log()

    mismatches = []
    for repo, rebuilt_rec in rebuilt.items():
        committed_rec = committed.get("repos", {}).get(repo)
        if committed_rec is None:
            mismatches.append(f"{repo}: present in raw_log but missing entirely from history.json")
            continue
        for series_name in ("daily_views", "daily_clones"):
            rebuilt_series = rebuilt_rec[series_name]
            committed_series = committed_rec.get(series_name, {})
            for date, rebuilt_val in rebuilt_series.items():
                committed_val = committed_series.get(date)
                if committed_val != rebuilt_val:
                    mismatches.append(
                        f"{repo}.{series_name}[{date}]: raw_log says {rebuilt_val}, "
                        f"history.json says {committed_val}"
                    )

    repos_in_log = len(rebuilt)
    repos_in_history = len(committed.get("repos", {}))
    print(f"Checked {repos_in_log} repos with raw evidence against {repos_in_history} repos in history.json.")

    if mismatches:
        print(f"\nDRIFT FOUND -- {len(mismatches)} mismatch(es):", file=sys.stderr)
        for m in mismatches[:50]:
            print(f"  - {m}", file=sys.stderr)
        if len(mismatches) > 50:
            print(f"  ... and {len(mismatches) - 50} more", file=sys.stderr)
        sys.exit(1)
    else:
        print("MATCH -- every daily_views/daily_clones value in history.json is a faithful merge of raw_log.jsonl.")
        sys.exit(0)


if __name__ == "__main__":
    main()
