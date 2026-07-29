#!/usr/bin/env python3
"""
Collects GitHub repo traffic + growth stats for all repos owned by OWNER
and merges them into a persistent data/history.json store.

Why this exists: GitHub's traffic API (views/clones) only returns a rolling
14-day window. Every day this runs, it merges that day's numbers into a
permanent local store keyed by calendar date -- so numbers that would
otherwise fall off GitHub's 14-day window are preserved forever, and the
dashboard's real usable history grows every day this runs.

Two auth modes (auto-detected):
  - GH_TOKEN/GITHUB_TOKEN env var set to a real PAT -> direct HTTPS calls
    (this is the mode used by the GitHub Actions workflow).
  - No token env var -> falls back to the `gh` CLI (must already be
    authenticated in the shell) -- used for local/manual runs.
No third-party services, no non-GitHub dependencies either way.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

OWNER = os.environ.get("GH_OWNER", "StewAlexander-com")
TOKEN = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
HERE = os.path.dirname(os.path.abspath(__file__))
HISTORY_PATH = os.path.join(HERE, "..", "data", "history.json")
API = "https://api.github.com"


def http_get(path):
    req = urllib.request.Request(f"{API}/{path}", headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "repo-stats-dashboard-collector",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return {"__error__": str(e)}


def gh_cli(path):
    try:
        out = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return {"__error__": out.stderr.strip()}
        return json.loads(out.stdout)
    except Exception as e:
        return {"__error__": str(e)}


def api_get(path):
    return http_get(path) if TOKEN else gh_cli(path)


def list_all_repos(owner):
    repos, page = [], 1
    while True:
        chunk = api_get(f"users/{owner}/repos?per_page=100&page={page}&type=owner")
        if not isinstance(chunk, list) or not chunk:
            break
        repos.extend(chunk)
        if len(chunk) < 100:
            break
        page += 1
    return repos


def load_history():
    if os.path.exists(HISTORY_PATH):
        with open(HISTORY_PATH) as f:
            return json.load(f)
    return {"owner": OWNER, "generated_at": None, "repos": {}}


def date_key(ts):
    return ts[:10]


def merge_series(existing, incoming):
    for item in incoming:
        d = date_key(item["timestamp"])
        existing[d] = {"count": item.get("count", 0), "uniques": item.get("uniques", 0)}
    return existing


def main():
    history = load_history()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    now_iso = datetime.now(timezone.utc).isoformat()

    repos = list_all_repos(OWNER)
    if not repos:
        print("WARNING: repo list came back empty -- aborting to avoid wiping history", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(repos)} repos for {OWNER} (auth mode: {'token' if TOKEN else 'gh-cli'})", file=sys.stderr)

    for r in repos:
        name = r["name"]
        rec = history["repos"].setdefault(name, {
            "daily_views": {}, "daily_clones": {}, "growth": {},
            "referrers": [], "popular_paths": []
        })

        rec["description"] = r.get("description") or ""
        rec["url"] = r.get("html_url") or r.get("url")
        rec["isPrivate"] = r.get("private", r.get("isPrivate", False))
        lang = r.get("language") or (r.get("primaryLanguage") or {}).get("name")
        rec["language"] = lang
        rec["createdAt"] = r.get("created_at") or r.get("createdAt")
        rec["pushedAt"] = r.get("pushed_at") or r.get("pushedAt")

        views = api_get(f"repos/{OWNER}/{name}/traffic/views")
        if isinstance(views, dict) and "views" in views:
            rec["daily_views"] = merge_series(rec.get("daily_views", {}), views["views"])

        clones = api_get(f"repos/{OWNER}/{name}/traffic/clones")
        if isinstance(clones, dict) and "clones" in clones:
            rec["daily_clones"] = merge_series(rec.get("daily_clones", {}), clones["clones"])

        referrers = api_get(f"repos/{OWNER}/{name}/traffic/popular/referrers")
        if isinstance(referrers, list):
            rec["referrers"] = referrers

        paths = api_get(f"repos/{OWNER}/{name}/traffic/popular/paths")
        if isinstance(paths, list):
            rec["popular_paths"] = paths

        repo_full = api_get(f"repos/{OWNER}/{name}")
        watchers, open_issues, default_branch = None, rec.get("open_issues", 0), rec.get("default_branch")
        stars = r.get("stargazers_count", r.get("stargazerCount", 0))
        forks = r.get("forks_count", r.get("forkCount", 0))
        if isinstance(repo_full, dict) and "__error__" not in repo_full:
            watchers = repo_full.get("subscribers_count", repo_full.get("watchers_count"))
            open_issues = repo_full.get("open_issues_count", open_issues)
            default_branch = repo_full.get("default_branch", default_branch)
            stars = repo_full.get("stargazers_count", stars)
            forks = repo_full.get("forks_count", forks)

        rec["open_issues"] = open_issues
        rec["default_branch"] = default_branch
        rec.setdefault("growth", {})[today] = {
            "stars": stars,
            "forks": forks,
            "watchers": watchers if watchers is not None else 0,
            "open_issues": open_issues,
        }
        rec["last_collected"] = now_iso
        print(f"  collected {name}", file=sys.stderr)
        time.sleep(0.05)

    history["generated_at"] = now_iso
    history["owner"] = OWNER

    os.makedirs(os.path.dirname(HISTORY_PATH), exist_ok=True)
    with open(HISTORY_PATH, "w") as f:
        json.dump(history, f, indent=2, sort_keys=True)

    print("DONE", file=sys.stderr)


if __name__ == "__main__":
    main()
