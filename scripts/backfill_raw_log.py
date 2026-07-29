#!/usr/bin/env python3
"""
One-time backfill: converts data/backfill_2026-07-29_initial_capture.json
(the actual, unmodified output of the very first collection run, made
before the raw_log.jsonl pipeline existed) into properly-formed raw_log
entries, so the audit trail has real evidence from day one instead of a
gap.

Honesty note: these entries are marked "backfilled": true. The underlying
API response *bodies* are authentic -- they were fetched directly from
GitHub's REST API on 2026-07-29 -- but they weren't captured through the
live JSONL-per-call pipeline that exists from this point forward, so they
are reconstructed from the aggregated output rather than logged call-by-call.
This script is only ever meant to run once; it's kept in the repo so the
provenance of the earliest data points remains inspectable.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", "data", "backfill_2026-07-29_initial_capture.json")
RAW_LOG_PATH = os.path.join(HERE, "..", "data", "raw_log.jsonl")
BACKFILL_TS = "2026-07-29T17:27:18Z"  # actual mtime of the original capture file


def main():
    with open(SOURCE) as f:
        repos = json.load(f)

    lines = []
    for r in repos:
        name = r["name"]
        if r.get("traffic_views"):
            lines.append({
                "run_ts": BACKFILL_TS, "repo": name, "endpoint": "traffic_views",
                "ok": True, "status": 200, "error": None,
                "body": r["traffic_views"], "backfilled": True,
            })
        if r.get("traffic_clones"):
            lines.append({
                "run_ts": BACKFILL_TS, "repo": name, "endpoint": "traffic_clones",
                "ok": True, "status": 200, "error": None,
                "body": r["traffic_clones"], "backfilled": True,
            })
        if r.get("referrers"):
            lines.append({
                "run_ts": BACKFILL_TS, "repo": name, "endpoint": "traffic_referrers",
                "ok": True, "status": 200, "error": None,
                "body": r["referrers"], "backfilled": True,
            })
        if r.get("popular_paths"):
            lines.append({
                "run_ts": BACKFILL_TS, "repo": name, "endpoint": "traffic_paths",
                "ok": True, "status": 200, "error": None,
                "body": r["popular_paths"], "backfilled": True,
            })

    # Prepend -- these are chronologically the earliest observations.
    existing = ""
    if os.path.exists(RAW_LOG_PATH):
        with open(RAW_LOG_PATH) as f:
            existing = f.read()

    with open(RAW_LOG_PATH, "w") as f:
        for entry in lines:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
        f.write(existing)

    print(f"Backfilled {len(lines)} raw_log entries from {len(repos)} repos (timestamp: {BACKFILL_TS}).")


if __name__ == "__main__":
    main()
