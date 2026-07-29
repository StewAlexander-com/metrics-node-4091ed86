// ---------- Passphrase gate (client-side deterrent, not real security) ----------
const GATE_HASH = "5148f58f10cb49b1f042475134f50a98673e3a46ebc2a01ca744ce9694e49384";

async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function tryUnlock(value) {
  const hash = await sha256(value.trim());
  return hash === GATE_HASH;
}

function showApp() {
  document.getElementById("gate").style.display = "none";
  document.getElementById("app").classList.add("visible");
  boot();
}

document.addEventListener("DOMContentLoaded", () => {
  const saved = sessionStorage.getItem("rsd_unlocked");
  if (saved === "1") {
    showApp();
    return;
  }
  const form = document.getElementById("gate-form");
  const input = document.getElementById("gate-input");
  const err = document.getElementById("gate-err");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ok = await tryUnlock(input.value);
    if (ok) {
      sessionStorage.setItem("rsd_unlocked", "1");
      showApp();
    } else {
      err.textContent = "Incorrect passphrase.";
      input.value = "";
      input.focus();
    }
  });
});

// ---------- Dashboard ----------
const PALETTE = {
  views: "#7aa2ff",
  clones: "#6ee7d0",
  stars: "#f0b45a",
  warn: "#ff6b81",
};

Chart.defaults.color = "#8b93a3";
Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, Segoe UI, Inter, Roboto, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.borderColor = "#262b36";

let HISTORY = null;

function fmt(n) {
  if (n === undefined || n === null) return "0";
  return n.toLocaleString("en-US");
}

// Sums only *observed* days -- a date with no entry contributes nothing,
// it is never treated as a zero-activity day.
function sumSeries(dailyObj, key) {
  return Object.values(dailyObj || {}).reduce((a, d) => a + (d[key] || 0), 0);
}

function sortedDates(dailyObj) {
  return Object.keys(dailyObj || {}).sort();
}

function timeAgo(iso) {
  if (!iso) return "unknown";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function boot() {
  const res = await fetch("data/history.json", { cache: "no-store" });
  HISTORY = await res.json();
  renderSummary();
  renderIntegrityPanel();
  renderLeaderboards();
  renderAccordionFromRows(buildRows().sort((a, b) => b.views - a.views));
  wireControls();
}

function buildRows() {
  return Object.entries(HISTORY.repos).map(([name, rec]) => ({ name, rec, ...computeRepoTotals(rec) }));
}

function computeRepoTotals(rec) {
  const growthDates = Object.keys(rec.growth || {}).sort();
  const latestGrowth = growthDates.length ? rec.growth[growthDates[growthDates.length - 1]] : null;
  return {
    views: sumSeries(rec.daily_views, "count"),
    viewUniques: sumSeries(rec.daily_views, "uniques"),
    clones: sumSeries(rec.daily_clones, "count"),
    cloneUniques: sumSeries(rec.daily_clones, "uniques"),
    stars: latestGrowth ? (latestGrowth.stars || 0) : 0,
    forks: latestGrowth ? (latestGrowth.forks || 0) : 0,
    watchers: latestGrowth ? (latestGrowth.watchers || 0) : 0,
    hasErrorsRecently: (rec.collection_errors || []).length > 0,
  };
}

function renderSummary() {
  const rows = buildRows();
  let totalViews = 0, totalViewUniq = 0, totalClones = 0, totalCloneUniq = 0;
  let totalStars = 0, totalForks = 0, totalWatchers = 0;
  let maxDays = 0;

  rows.forEach(row => {
    totalViews += row.views;
    totalViewUniq += row.viewUniques;
    totalClones += row.clones;
    totalCloneUniq += row.cloneUniques;
    totalStars += row.stars;
    totalForks += row.forks;
    totalWatchers += row.watchers;
    maxDays = Math.max(maxDays, sortedDates(row.rec.daily_views).length);
  });

  document.getElementById("generated-at").textContent =
    HISTORY.generated_at ? new Date(HISTORY.generated_at).toLocaleString() : "unknown";
  document.getElementById("owner-name").textContent = HISTORY.owner || "";
  document.getElementById("repo-count").textContent = rows.length;
  document.getElementById("window-days").textContent = maxDays;

  const cards = [
    { label: "Total Views", value: totalViews, sub: `${fmt(totalViewUniq)} unique visitors &middot; sum of observed days only`, cls: "accent-views" },
    { label: "Total Clones", value: totalClones, sub: `${fmt(totalCloneUniq)} unique cloners &middot; sum of observed days only`, cls: "accent-clones" },
    { label: "Total Stars", value: totalStars, sub: "point-in-time snapshot, most recent run", cls: "accent-stars" },
    { label: "Total Forks", value: totalForks, sub: "point-in-time snapshot, most recent run", cls: "" },
    { label: "Total Watchers", value: totalWatchers, sub: "point-in-time snapshot, most recent run", cls: "" },
    { label: "Repos Tracked", value: rows.length, sub: "see integrity panel for exclusions", cls: "" },
  ];

  const grid = document.getElementById("summary-cards");
  grid.innerHTML = cards.map(c => `
    <div class="card ${c.cls}">
      <div class="label">${c.label}</div>
      <div class="value">${fmt(c.value)}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join("");
}

function renderIntegrityPanel() {
  const lr = HISTORY.last_run || {};
  const panel = document.getElementById("integrity-panel");
  const okCount = lr.repos_ok ?? "?";
  const totalCount = lr.repos_total ?? "?";
  const clean = okCount === totalCount;
  const errors = lr.repos_with_errors || [];
  const excluded = lr.repos_excluded || [];
  const runUrl = lr.github_run_url;

  const errorsHtml = errors.length ? `
    <details style="margin-top:8px;">
      <summary style="cursor:pointer; color:var(--danger);">${errors.length} repo(s) had a collection error on the last run &mdash; click to see exactly which endpoint failed and why</summary>
      <table class="mini" style="margin-top:8px;">
        <thead><tr><th>Repo</th><th>Failed endpoint(s)</th></tr></thead>
        <tbody>
          ${errors.map(e => `<tr><td>${escapeHtml(e.repo)}</td><td>${e.errors.map(x => escapeHtml(`${x.endpoint}: ${x.error || x.status || "unknown"}`)).join("<br>")}</td></tr>`).join("")}
        </tbody>
      </table>
      <div class="empty-note" style="text-align:left; padding:8px 0 0;">A failed endpoint means that repo's number for that metric was left untouched (not zeroed) until the next successful run.</div>
    </details>` : `<div style="color:var(--accent); margin-top:6px; font-size:12.5px;">No collection errors on the last run.</div>`;

  const excludedHtml = excluded.length ? `
    <div style="margin-top:8px; font-size:12.5px; color:var(--text-dim);">
      Explicitly excluded (documented, not silent): ${excluded.map(escapeHtml).join(", ")} &mdash; disposable setup artifact, not a real project.
    </div>` : "";

  panel.innerHTML = `
    <div class="chart-box" style="margin-bottom:16px;">
      <h4>Last collection run</h4>
      <div style="font-size:13px; color:var(--text-dim); line-height:1.7;">
        <strong style="color:${clean ? 'var(--accent)' : 'var(--accent-3)'}">${okCount} / ${totalCount} repos collected cleanly</strong>
        at ${lr.timestamp ? new Date(lr.timestamp).toLocaleString() : "unknown"}.
        ${runUrl ? `<a class="repo-link" href="${runUrl}" target="_blank" rel="noopener">View this run's automation log &#8599;</a>` : `<span style="color:var(--text-faint);">(run locally / no linked automation log for this run)</span>`}
      </div>
      ${errorsHtml}
      ${excludedHtml}
      <div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--border); font-size:12px; color:var(--text-faint); line-height:1.8;">
        <strong style="color:var(--text-dim);">How to independently verify any number on this page:</strong><br>
        1. Every raw API response this collector has ever received is appended, unmodified, to
        <a class="repo-link" href="data/raw_log.jsonl" target="_blank" rel="noopener">data/raw_log.jsonl</a> &mdash; that file is never rewritten, only appended to.<br>
        2. <a class="repo-link" href="data/history.json" target="_blank" rel="noopener">data/history.json</a> (what this page reads) is a derived view built from that log.<br>
        3. <code>scripts/verify_history.py</code> rebuilds the derived view from raw evidence alone and diffs it against what's committed &mdash; if they ever disagree, that script says exactly where, loudly.<br>
        4. Every commit to this repo is timestamped and public in the repo's own commit history, so any historical value can be traced to the exact automated run that produced it.<br><br>
        <strong style="color:var(--text-dim);">What GitHub's own numbers do and don't mean:</strong> "views"/"clones" are GitHub's server-side counts and may include automated traffic (CI, bots, link previews) &mdash; they are not a proxy for human interest alone.
        "Uniques" are GitHub's own deduplication logic, not independently verified.
        GitHub explicitly caches/finalizes same-day counts progressively, so the most recent date on any chart below is provisional and may still increase.
        GitHub only ever exposes a rolling 14-day window for views/clones and a snapshot-only view for referrers/paths (not accumulated) &mdash; see
        <a class="repo-link" href="https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository" target="_blank" rel="noopener">GitHub's traffic docs &#8599;</a>.
      </div>
    </div>`;
}

function renderLeaderboards() {
  const rows = buildRows();
  const topViews = [...rows].sort((a, b) => b.views - a.views).slice(0, 8);
  const topClones = [...rows].sort((a, b) => b.clones - a.clones).slice(0, 8);

  new Chart(document.getElementById("chart-top-views"), {
    type: "bar",
    data: {
      labels: topViews.map(r => r.name),
      datasets: [{ label: "Views", data: topViews.map(r => r.views), backgroundColor: PALETTE.views, borderRadius: 4 }]
    },
    options: baseBarOptions()
  });

  new Chart(document.getElementById("chart-top-clones"), {
    type: "bar",
    data: {
      labels: topClones.map(r => r.name),
      datasets: [{ label: "Clones", data: topClones.map(r => r.clones), backgroundColor: PALETTE.clones, borderRadius: 4 }]
    },
    options: baseBarOptions()
  });
}

function baseBarOptions() {
  return {
    indexAxis: "y",
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: "#1c202a" }, ticks: { precision: 0 } },
      y: { grid: { display: false }, ticks: { font: { size: 10.5 } } }
    }
  };
}

function lineOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    spanGaps: false, // real gaps stay as visible breaks -- never bridged, never implied
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10.5 } } } },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 9.5 }, maxRotation: 0 } },
      y: { grid: { color: "#1c202a" }, ticks: { precision: 0, font: { size: 10 } }, beginAtZero: true }
    }
  };
}

function shortDate(d) {
  const [, m, day] = d.split("-");
  return `${m}/${day}`;
}

// Builds a continuous list of calendar dates between min and max of the
// supplied date lists (inclusive), so missing days render as real gaps
// in the chart rather than being skipped (which visually compresses a
// gap into invisibility) or defaulted to zero (which fabricates data).
function continuousDateRange(dateLists) {
  const all = dateLists.flat();
  if (!all.length) return [];
  const sorted = [...all].sort();
  const start = new Date(sorted[0] + "T00:00:00Z");
  const end = new Date(sorted[sorted.length - 1] + "T00:00:00Z");
  const out = [];
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderRepoBody(item, row) {
  const body = item.querySelector(".accordion-body");
  const rec = row.rec;
  const viewDates = sortedDates(rec.daily_views);
  const cloneDates = sortedDates(rec.daily_clones);
  const growthDates = Object.keys(rec.growth || {}).sort();
  const errors = rec.collection_errors || [];
  const today = todayUTC();

  const trafficId = `chart-traffic-${cssSafe(row.name)}`;
  const growthId = `chart-growth-${cssSafe(row.name)}`;

  const errorNote = errors.length ? `
    <div style="font-size:11.5px; color:var(--accent-3); margin-top:8px;">
      &#9888; ${errors.length} recent collection attempt(s) failed for this repo (endpoint errors, not zero activity) &mdash;
      most recent: ${escapeHtml(errors[errors.length - 1].errors.map(e => e.endpoint).join(", "))} on ${new Date(errors[errors.length - 1].run_ts).toLocaleString()}.
    </div>` : "";

  body.innerHTML = `
    <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-top:14px;">
      <span class="stat-mini">
        <span>Forks: <b>${fmt(row.forks)}</b></span>
        <span>Watchers: <b>${fmt(row.watchers)}</b></span>
        <span>Unique visitors: <b>${fmt(row.viewUniques)}</b></span>
        <span>Unique cloners: <b>${fmt(row.cloneUniques)}</b></span>
      </span>
      <a class="repo-link" href="${rec.url}" target="_blank" rel="noopener">View on GitHub &#8599;</a>
    </div>
    ${errorNote}
    <div class="body-grid">
      <div class="chart-box">
        <h4>Views &amp; clones by day (gaps = not observed, not zero)</h4>
        ${viewDates.length || cloneDates.length ? `<canvas id="${trafficId}"></canvas><div class="empty-note" style="padding:6px 0 0;">Date range shown: ${viewDates.concat(cloneDates).sort()[0]} to ${today}. Today's point is provisional.</div>` : `<div class="empty-note">No traffic observed in GitHub's reporting window for this repo.</div>`}
      </div>
      <div class="chart-box">
        <h4>Stars over time (accumulates as this dashboard keeps running)</h4>
        ${growthDates.length >= 2 ? `<canvas id="${growthId}"></canvas>` : `<div class="empty-note">Only ${growthDates.length} day(s) of growth snapshot collected so far.<br>A trend line appears once a few more days accumulate.<br>Current: ${fmt(row.stars)} stars (as of ${growthDates.length ? new Date(rec.growth[growthDates[growthDates.length-1]] ? rec.last_collected : rec.last_collected).toLocaleDateString() : "n/a"})</div>`}
      </div>
      <div class="chart-box">
        <h4>Top referrers &mdash; latest snapshot only, not accumulated</h4>
        ${renderTable(rec.referrers, [["referrer", "Source"], ["count", "Views"], ["uniques", "Unique"]])}
      </div>
      <div class="chart-box">
        <h4>Popular paths &mdash; latest snapshot only, not accumulated</h4>
        ${renderTable(rec.popular_paths, [["path", "Path"], ["count", "Views"], ["uniques", "Unique"]])}
      </div>
    </div>
    <div style="margin-top:10px; color:var(--text-faint); font-size:11px;">
      Last collection attempt: ${timeAgo(rec.last_collected)} (${rec.last_collected ? new Date(rec.last_collected).toLocaleString() : "n/a"})
      &middot; Created: ${rec.createdAt ? new Date(rec.createdAt).toLocaleDateString() : "n/a"}
      &middot; Last push: ${rec.pushedAt ? new Date(rec.pushedAt).toLocaleDateString() : "n/a"}
    </div>
  `;

  if (viewDates.length || cloneDates.length) {
    const allDates = continuousDateRange([viewDates, cloneDates]);
    // null = not observed this date (real gap); a present entry is used as-is,
    // including a legitimate 0 if GitHub reported zero activity that day.
    const viewData = allDates.map(d => (d in rec.daily_views) ? rec.daily_views[d].count : null);
    const cloneData = allDates.map(d => (d in rec.daily_clones) ? rec.daily_clones[d].count : null);
    new Chart(document.getElementById(trafficId), {
      type: "line",
      data: {
        labels: allDates.map(shortDate),
        datasets: [
          { label: "Views", data: viewData, borderColor: PALETTE.views, backgroundColor: PALETTE.views, tension: 0.25, pointRadius: 2 },
          { label: "Clones", data: cloneData, borderColor: PALETTE.clones, backgroundColor: PALETTE.clones, tension: 0.25, pointRadius: 2 },
        ]
      },
      options: lineOptions()
    });
  }

  if (growthDates.length >= 2) {
    new Chart(document.getElementById(growthId), {
      type: "line",
      data: {
        labels: growthDates.map(shortDate),
        datasets: [
          { label: "Stars", data: growthDates.map(d => rec.growth[d].stars), borderColor: PALETTE.stars, backgroundColor: PALETTE.stars, tension: 0.25, pointRadius: 2 },
        ]
      },
      options: lineOptions()
    });
  }
}

function renderTable(rows, cols) {
  if (!rows || !rows.length) return `<div class="empty-note">No data recorded.</div>`;
  const head = cols.map(([, label]) => `<th>${label}</th>`).join("");
  const body = rows.slice(0, 8).map(r => `<tr>${cols.map(([key]) => `<td>${escapeHtml(r[key] ?? "")}</td>`).join("")}</tr>`).join("");
  return `<table class="mini"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function cssSafe(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function renderAccordionFromRows(rows) {
  const container = document.getElementById("accordion");
  container.innerHTML = "";
  rows.forEach(row => {
    const item = document.createElement("div");
    item.className = "accordion-item";
    item.dataset.name = row.name.toLowerCase();
    item.dataset.desc = (row.rec.description || "").toLowerCase();
    item.dataset.lang = (row.rec.language || "").toLowerCase();

    const header = document.createElement("div");
    header.className = "accordion-header";
    header.innerHTML = `
      <span class="chev">&#9656;</span>
      <span class="name">${escapeHtml(row.name)}</span>
      ${row.rec.isPrivate ? '<span class="badge private">private</span>' : ''}
      ${row.rec.language ? `<span class="badge">${escapeHtml(row.rec.language)}</span>` : ''}
      ${row.hasErrorsRecently ? '<span class="badge" style="color:var(--accent-3); border-color:#4a3a1f;" title="Had a collection error recently">&#9888; error</span>' : ''}
      <span class="desc">${escapeHtml(row.rec.description || "")}</span>
      <span class="stat-mini">
        <span>&#9733; <b>${fmt(row.stars)}</b></span>
        <span>&#128065; <b>${fmt(row.views)}</b></span>
        <span>&#8681; <b>${fmt(row.clones)}</b></span>
      </span>
    `;
    header.addEventListener("click", () => {
      const wasOpen = item.classList.contains("open");
      if (!wasOpen && !item.dataset.rendered) {
        renderRepoBody(item, row);
        item.dataset.rendered = "1";
      }
      item.classList.toggle("open");
    });

    const bodyEl = document.createElement("div");
    bodyEl.className = "accordion-body";
    item.appendChild(header);
    item.appendChild(bodyEl);
    container.appendChild(item);
  });
  document.getElementById("visible-count").textContent = rows.length;
}

function wireControls() {
  const search = document.getElementById("search");
  const sortSel = document.getElementById("sort-by");

  function apply() {
    const q = search.value.trim().toLowerCase();
    const items = Array.from(document.querySelectorAll(".accordion-item"));
    let visible = 0;
    items.forEach(item => {
      const match = !q || item.dataset.name.includes(q) || item.dataset.desc.includes(q) || item.dataset.lang.includes(q);
      item.style.display = match ? "" : "none";
      if (match) visible++;
    });
    document.getElementById("visible-count").textContent = visible;
  }

  search.addEventListener("input", apply);

  sortSel.addEventListener("change", () => {
    const rows = buildRows();
    const key = sortSel.value;
    if (key === "name") rows.sort((a, b) => a.name.localeCompare(b.name));
    else if (key === "views") rows.sort((a, b) => b.views - a.views);
    else if (key === "clones") rows.sort((a, b) => b.clones - a.clones);
    else if (key === "stars") rows.sort((a, b) => b.stars - a.stars);
    else if (key === "pushed") rows.sort((a, b) => new Date(b.rec.pushedAt) - new Date(a.rec.pushedAt));
    renderAccordionFromRows(rows);
    apply();
  });
}
