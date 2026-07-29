# Repo Stats Dashboard

Private-by-obscurity dashboard of views/clones/stars/forks/watchers across all
repos on this account, hosted on GitHub Pages and kept up to date by a GitHub
Actions workflow. No third-party services, no subscriptions — everything runs
on GitHub's own free infrastructure.

## One-time setup required

GitHub's Traffic API (views/clones/referrers/paths) only lets a token see
data for repos it has push access to, and the workflow needs to read *every*
repo on the account, not just this one — so the built-in `GITHUB_TOKEN` isn't
enough (it's scoped to only this repo). You need to add one secret, once:

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens) →
   **Generate new token (classic)**.
2. Scope: check **repo** (full control of private repositories — this is what
   grants traffic-API read access across all your repos).
3. Set an expiration (90 days, 1 year, or no expiration — your call; if it
   expires, the workflow will start failing and you'll need to rotate it).
4. Copy the token.
5. In *this* repo: **Settings → Secrets and variables → Actions → New
   repository secret**.
   - Name: `TRAFFIC_PAT`
   - Value: the token you copied
6. Done. The workflow (`.github/workflows/collect.yml`) runs daily at
   11:17 UTC and can also be triggered manually from the **Actions** tab
   (`workflow_dispatch`).

## How the data compounds

GitHub only reports a rolling 14-day window for views/clones. Every run,
`scripts/collect.py` merges that day's numbers into `data/history.json`,
keyed by calendar date. Once a date is captured here it's kept permanently —
so the dashboard's real history keeps growing the longer this runs, even
though GitHub itself only ever shows you the last 14 days at a time.

## Files

- `index.html` / `style.css` / `app.js` — the dashboard (static, client-side
  only, reads `data/history.json`).
- `scripts/collect.py` — the collector. Works two ways: via a real token
  (`GH_TOKEN` env var, used by Actions) or via the `gh` CLI if already
  authenticated (used for local/manual runs).
- `data/history.json` — the compounding data store.
- `.github/workflows/collect.yml` — the daily scheduled job.

## Privacy note

GitHub Pages sites are always publicly reachable by URL on every plan short
of GitHub Enterprise Cloud — there's no way to make a truly access-gated
Pages site here. This dashboard is protected only by (a) an unguessable URL
that isn't linked from anywhere, and (b) a client-side passphrase screen.
Neither is real security — anyone who finds the URL and reads the page
source can see the passphrase hash and, with effort, the data. Don't put
anything more sensitive than repo view/clone counts behind this gate.
