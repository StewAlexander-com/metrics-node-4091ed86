#!/usr/bin/env python3
"""
Collects GitHub repo traffic + growth stats for all repos owned by OWNER
and merges them into a persistent data/history.json store.

HONESTY / AUDITABILITY DESIGN:
  - Every raw API response (or error) for every repo/endpoint/run is appended,
    verbatim, to data/raw_log.jsonl. This file is never rewritten, only
    appended to -- it is the permanent ground truth. history.json is a
    *derived* view that can always be rebuilt from raw_log.jsonl via
    scripts/verify_history.py. If the two ever disagree, that's a bug, and
    verify_history.py will say so loudly.
  - A value is only ever recorded if GitHub's API actually returned it for
    that date. Dates with no observation are left absent (not zero) --
    the dashboard renders these as real gaps, not fabricated zeros.
  - Every run's outcome (which repos succeeded/failed per endpoint) is
    recorded in history.json's `last_run` block, so failures are visible
    instead of silently producing incomplete-looking data with no explanation.
  - Provenance: when running inside GitHub Actions, the workflow's run URL
    and commit SHA are captured into `last_run` so every number on the
    dashboard can be traced to the exact automated run that produced it.

Why this exists at all: GitHub's traffic API (views/clones) only returns a
rolling 14-day window. Every day this runs, it merges that day's numbers
into a permanent local store keyed by calendar date -- so numbers that
would otherwise fall off GitHub's 14-day window are preserved forever.

Two auth modes (auto-detected):
  - GH_TOKEN/GITHUB_TOKEN env var set to a real PAT -> direct HTTPS calls
    (used by the GitHub Actions workflow).
  - No token env var -> falls back to the `gh` CLI (must already be
    authenticated in the shell) -- used for local/manual runs.
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

# Explicit, documented exclusion -- not a silent filter. This repo is a
# disposable artifact left over from setting up this dashboard's GitHub
# connector access; it is not a real project and including it would just
# add noise. Anyone auditing this file can see exactly what's excluded
# and why -- nothing is hidden.
EXCLUDED_REPOS = {"pplx-connector-test-delete-me"}
HERE = os.path.dirname(os.path.abspath(__file__))
HISTORY_PATH = os.path.join(HERE, "..", "data", "history.json")
RAW_LOG_PATH = os.path.join(HERE, "..", "data", "raw_log.jsonl")
API = "https://api.github.com"

RUN_TS = datetime.now(timezone.utc).isoformat()
RUN_TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")


def http_get(path):
    req = urllib.request.Request(f"{API}/{path}", headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "repo-stats-dashboard-collector",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return {"ok": True, "status": resp.status, "body": json.loads(resp.read().decode())}
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode())
        except Exception:
            body = None
        return {"ok": False, "status": e.code, "body": body, "error": str(e)}
    except Exception as e:
        return {"ok": False, "status": None, "body": None, "error": str(e)}


def gh_cli(path, retries=3):
    last_err = None
    for attempt in range(retries):
        try:
            out = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=30)
            if out.returncode != 0:
                last_err = out.stderr.strip()
                if "429" in last_err and attempt < retries - 1:
                    time.sleep(2 * (attempt + 1))
                    continue
                return {"ok": False, "status": None, "body": None, "error": last_err}
            return {"ok": True, "status": 200, "body": json.loads(out.stdout)}
        except Exception as e:
            last_err = str(e)
    return {"ok": False, "status": None, "body": None, "error": last_err}


def api_get_raw(path):
    """Returns {ok, status, body, error?} -- never raises."""
    return http_get(path) if TOKEN else gh_cli(path)


RAW_LOG_BUFFER = []


def log_raw(repo, endpoint, result):
    RAW_LOG_BUFFER.append({
        "run_ts": RUN_TS,
        "repo": repo,
        "endpoint": endpoint,
        "ok": result["ok"],
        "status": result.get("status"),
        "error": result.get("error"),
        # Store the body verbatim -- this is the ground truth evidence.
        "body": result.get("body"),
    })


def api_get(repo, endpoint_label, path):
    result = api_get_raw(path)
    log_raw(repo, endpoint_label, result)
    return result


def list_all_repos(owner):
    """Uses /user/repos (the authenticated user's own repos, including
    private ones) rather than /users/{owner}/repos, which -- per GitHub's
    own docs -- only ever returns PUBLIC repos regardless of auth. Using
    the wrong endpoint here would silently under-count private repos on
    every single run, which is exactly the kind of quiet omission this
    dashboard is meant to avoid."""
    repos, page = [], 1
    while True:
        result = api_get("__account__", f"list_repos_page_{page}", f"user/repos?per_page=100&page={page}&affiliation=owner")
        chunk = result.get("body")
        if not result["ok"] or not isinstance(chunk, list) or not chunk:
            break
        repos.extend([r for r in chunk if (r.get("owner") or {}).get("login") == owner])
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
    changed_dates = []
    for item in incoming:
        d = date_key(item["timestamp"])
        new_val = {"count": item.get("count", 0), "uniques": item.get("uniques", 0)}
        if existing.get(d) != new_val:
            changed_dates.append(d)
        existing[d] = new_val
    return existing, changed_dates


def main():
    history = load_history()
    repos = list_all_repos(OWNER)

    run_result = {
        "timestamp": RUN_TS,
        "repos_total": 0,
        "repos_ok": 0,
        "repos_with_errors": [],
        "repos_excluded": sorted(EXCLUDED_REPOS),
        "github_run_url": None,
        "github_workflow": os.environ.get("GITHUB_WORKFLOW"),
    }

    server = os.environ.get("GITHUB_SERVER_URL")
    repo_slug = os.environ.get("GITHUB_REPOSITORY")
    run_id = os.environ.get("GITHUB_RUN_ID")
    if server and repo_slug and run_id:
        run_result["github_run_url"] = f"{server}/{repo_slug}/actions/runs/{run_id}"

    if not repos:
        run_result["fatal_error"] = "repo list came back empty -- aborting to avoid wiping history"
        print(run_result["fatal_error"], file=sys.stderr)
        flush_raw_log()
        history["last_run"] = run_result
        save_history(history)
        sys.exit(1)

    repos = [r for r in repos if r["name"] not in EXCLUDED_REPOS]

    run_result["repos_total"] = len(repos)
    print(f"Found {len(repos)} repos for {OWNER} (auth mode: {'token' if TOKEN else 'gh-cli'}, excluded: {sorted(EXCLUDED_REPOS)})", file=sys.stderr)

    for r in repos:
        name = r["name"]
        rec = history["repos"].setdefault(name, {
            "daily_views": {}, "daily_clones": {}, "growth": {},
            "referrers": [], "popular_paths": [], "collection_errors": []
        })
        rec.setdefault("collection_errors", [])
        repo_errors = []

        rec["description"] = r.get("description") or ""
        rec["url"] = r.get("html_url") or r.get("url")
        rec["isPrivate"] = r.get("private", r.get("isPrivate", False))
        lang = r.get("language") or (r.get("primaryLanguage") or {}).get("name")
        rec["language"] = lang
        rec["createdAt"] = r.get("created_at") or r.get("createdAt")
        rec["pushedAt"] = r.get("pushed_at") or r.get("pushedAt")

        views = api_get(name, "traffic_views", f"repos/{OWNER}/{name}/traffic/views")
        if views["ok"] and isinstance(views["body"], dict) and "views" in views["body"]:
            rec["daily_views"], _ = merge_series(rec.get("daily_views", {}), views["body"]["views"])
        elif not views["ok"]:
            repo_errors.append({"endpoint": "traffic_views", "status": views.get("status"), "error": views.get("error")})

        clones = api_get(name, "traffic_clones", f"repos/{OWNER}/{name}/traffic/clones")
        if clones["ok"] and isinstance(clones["body"], dict) and "clones" in clones["body"]:
            rec["daily_clones"], _ = merge_series(rec.get("daily_clones", {}), clones["body"]["clones"])
        elif not clones["ok"]:
            repo_errors.append({"endpoint": "traffic_clones", "status": clones.get("status"), "error": clones.get("error")})

        referrers = api_get(name, "traffic_referrers", f"repos/{OWNER}/{name}/traffic/popular/referrers")
        if referrers["ok"] and isinstance(referrers["body"], list):
            rec["referrers"] = referrers["body"]
        elif not referrers["ok"]:
            repo_errors.append({"endpoint": "traffic_referrers", "status": referrers.get("status"), "error": referrers.get("error")})

        paths = api_get(name, "traffic_paths", f"repos/{OWNER}/{name}/traffic/popular/paths")
        if paths["ok"] and isinstance(paths["body"], list):
            rec["popular_paths"] = paths["body"]
        elif not paths["ok"]:
            repo_errors.append({"endpoint": "traffic_paths", "status": paths.get("status"), "error": paths.get("error")})

        repo_full = api_get(name, "repo_detail", f"repos/{OWNER}/{name}")
        watchers, open_issues, default_branch = None, rec.get("open_issues", 0), rec.get("default_branch")
        stars = r.get("stargazers_count", r.get("stargazerCount", 0))
        forks = r.get("forks_count", r.get("forkCount", 0))
        if repo_full["ok"] and isinstance(repo_full["body"], dict):
            body = repo_full["body"]
            watchers = body.get("subscribers_count", body.get("watchers_count"))
            open_issues = body.get("open_issues_count", open_issues)
            default_branch = body.get("default_branch", default_branch)
            stars = body.get("stargazers_count", stars)
            forks = body.get("forks_count", forks)
        elif not repo_full["ok"]:
            repo_errors.append({"endpoint": "repo_detail", "status": repo_full.get("status"), "error": repo_full.get("error")})

        rec["open_issues"] = open_issues
        rec["default_branch"] = default_branch
        # Only record a growth snapshot for today if we actually got fresh repo
        # detail this run -- otherwise we'd be recording stale/fallback numbers
        # as if they were freshly observed.
        if repo_full["ok"]:
            rec.setdefault("growth", {})[RUN_TODAY] = {
                "stars": stars, "forks": forks,
                "watchers": watchers if watchers is not None else 0,
                "open_issues": open_issues,
            }
        rec["last_collected"] = RUN_TS
        if repo_errors:
            rec["collection_errors"] = (rec["collection_errors"] + [{"run_ts": RUN_TS, "errors": repo_errors}])[-10:]
            run_result["repos_with_errors"].append({"repo": name, "errors": repo_errors})
        else:
            run_result["repos_ok"] += 1
        print(f"  collected {name}{' (errors)' if repo_errors else ''}", file=sys.stderr)
        time.sleep(0.3)

    history["generated_at"] = RUN_TS
    history["owner"] = OWNER
    history["last_run"] = run_result

    flush_raw_log()
    save_history(history)
    print(f"DONE -- {run_result['repos_ok']}/{run_result['repos_total']} repos collected cleanly", file=sys.stderr)


def flush_raw_log():
    os.makedirs(os.path.dirname(RAW_LOG_PATH), exist_ok=True)
    with open(RAW_LOG_PATH, "a") as f:
        for entry in RAW_LOG_BUFFER:
            f.write(json.dumps(entry, sort_keys=True) + "\n")


def save_history(history):
    os.makedirs(os.path.dirname(HISTORY_PATH), exist_ok=True)
    with open(HISTORY_PATH, "w") as f:
        json.dump(history, f, indent=2, sort_keys=True)


if __name__ == "__main__":
    main()
