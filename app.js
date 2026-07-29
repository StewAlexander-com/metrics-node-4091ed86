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
  viewsUniq: "#3d5aa8",
  clones: "#6ee7d0",
  clonesUniq: "#3f9f8e",
  stars: "#f0b45a",
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

async function boot() {
  const res = await fetch("data/history.json", { cache: "no-store" });
  HISTORY = await res.json();
  renderSummary();
  renderLeaderboards();
  renderAccordion();
  wireControls();
}

function computeRepoTotals(rec) {
  return {
    views: sumSeries(rec.daily_views, "count"),
    viewUniques: sumSeries(rec.daily_views, "uniques"),
    clones: sumSeries(rec.daily_clones, "count"),
    cloneUniques: sumSeries(rec.daily_clones, "uniques"),
    stars: (() => {
      const dates = Object.keys(rec.growth || {}).sort();
      return dates.length ? rec.growth[dates[dates.length - 1]].stars || 0 : 0;
    })(),
    forks: (() => {
      const dates = Object.keys(rec.growth || {}).sort();
      return dates.length ? rec.growth[dates[dates.length - 1]].forks || 0 : 0;
    })(),
    watchers: (() => {
      const dates = Object.keys(rec.growth || {}).sort();
      return dates.length ? rec.growth[dates[dates.length - 1]].watchers || 0 : 0;
    })(),
  };
}

function renderSummary() {
  const repos = HISTORY.repos;
  const names = Object.keys(repos);
  let totalViews = 0, totalViewUniq = 0, totalClones = 0, totalCloneUniq = 0;
  let totalStars = 0, totalForks = 0, totalWatchers = 0;
  let maxDays = 0;

  names.forEach(name => {
    const t = computeRepoTotals(repos[name]);
    totalViews += t.views;
    totalViewUniq += t.viewUniques;
    totalClones += t.clones;
    totalCloneUniq += t.cloneUniques;
    totalStars += t.stars;
    totalForks += t.forks;
    totalWatchers += t.watchers;
    maxDays = Math.max(maxDays, sortedDates(repos[name].daily_views).length);
  });

  document.getElementById("generated-at").textContent =
    HISTORY.generated_at ? new Date(HISTORY.generated_at).toLocaleString() : "unknown";
  document.getElementById("owner-name").textContent = HISTORY.owner || "";
  document.getElementById("repo-count").textContent = names.length;
  document.getElementById("window-days").textContent = maxDays;

  const cards = [
    { label: "Total Views", value: totalViews, sub: `${fmt(totalViewUniq)} unique visitors`, cls: "accent-views" },
    { label: "Total Clones", value: totalClones, sub: `${fmt(totalCloneUniq)} unique cloners`, cls: "accent-clones" },
    { label: "Total Stars", value: totalStars, sub: "across all repos", cls: "accent-stars" },
    { label: "Total Forks", value: totalForks, sub: "across all repos", cls: "" },
    { label: "Total Watchers", value: totalWatchers, sub: "across all repos", cls: "" },
    { label: "Repos Tracked", value: names.length, sub: "in this account", cls: "" },
  ];

  const grid = document.getElementById("summary-cards");
  grid.innerHTML = cards.map(c => `
    <div class="card ${c.cls}">
      <div class="label">${c.label}</div>
      <div class="value">${fmt(c.value)}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join("");
}

function renderLeaderboards() {
  const repos = HISTORY.repos;
  const rows = Object.entries(repos).map(([name, rec]) => ({ name, ...computeRepoTotals(rec) }));

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
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10.5 } } } },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 9.5 }, maxRotation: 0 } },
      y: { grid: { color: "#1c202a" }, ticks: { precision: 0, font: { size: 10 } }, beginAtZero: true }
    }
  };
}

function shortDate(d) {
  const [y, m, day] = d.split("-");
  return `${m}/${day}`;
}

function renderAccordion() {
  const repos = HISTORY.repos;
  const rows = Object.entries(repos).map(([name, rec]) => ({ name, rec, ...computeRepoTotals(rec) }));
  rows.sort((a, b) => b.views - a.views);

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

    const body = document.createElement("div");
    body.className = "accordion-body";

    item.appendChild(header);
    item.appendChild(body);
    container.appendChild(item);
  });

  document.getElementById("visible-count").textContent = rows.length;
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

  const trafficId = `chart-traffic-${cssSafe(row.name)}`;
  const growthId = `chart-growth-${cssSafe(row.name)}`;

  body.innerHTML = `
    <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-top:14px;">
      <span class="stat-mini">
        <span>Forks: <b>${fmt(row.forks)}</b></span>
        <span>Watchers: <b>${fmt(row.watchers)}</b></span>
        <span>Unique visitors (14d): <b>${fmt(row.viewUniques)}</b></span>
        <span>Unique cloners (14d): <b>${fmt(row.cloneUniques)}</b></span>
      </span>
      <a class="repo-link" href="${rec.url}" target="_blank" rel="noopener">View on GitHub &#8599;</a>
    </div>
    <div class="body-grid">
      <div class="chart-box">
        <h4>Views &amp; Clones (per day, GitHub-reported window)</h4>
        ${viewDates.length || cloneDates.length ? `<canvas id="${trafficId}"></canvas>` : `<div class="empty-note">No traffic recorded yet in this window.</div>`}
      </div>
      <div class="chart-box">
        <h4>Stars over time (accumulates daily as this dashboard runs)</h4>
        ${growthDates.length >= 2 ? `<canvas id="${growthId}"></canvas>` : `<div class="empty-note">Only ${growthDates.length} day(s) of growth data collected so far.<br>A trend line appears once a few more days accumulate.<br>Current: ${fmt(row.stars)} stars</div>`}
      </div>
      <div class="chart-box">
        <h4>Top referrers (14d)</h4>
        ${renderTable(rec.referrers, [["referrer", "Source"], ["count", "Views"], ["uniques", "Unique"]])}
      </div>
      <div class="chart-box">
        <h4>Popular paths (14d)</h4>
        ${renderTable(rec.popular_paths, [["path", "Path"], ["count", "Views"], ["uniques", "Unique"]])}
      </div>
    </div>
    <div style="margin-top:10px; color:var(--text-faint); font-size:11px;">
      Last collected: ${timeAgo(rec.last_collected)} &middot; Created: ${rec.createdAt ? new Date(rec.createdAt).toLocaleDateString() : "n/a"} &middot; Last push: ${rec.pushedAt ? new Date(rec.pushedAt).toLocaleDateString() : "n/a"}
    </div>
  `;

  if (viewDates.length || cloneDates.length) {
    const allDates = Array.from(new Set([...viewDates, ...cloneDates])).sort();
    new Chart(document.getElementById(trafficId), {
      type: "line",
      data: {
        labels: allDates.map(shortDate),
        datasets: [
          { label: "Views", data: allDates.map(d => (rec.daily_views[d] || {}).count || 0), borderColor: PALETTE.views, backgroundColor: PALETTE.views, tension: 0.25, pointRadius: 2 },
          { label: "Clones", data: allDates.map(d => (rec.daily_clones[d] || {}).count || 0), borderColor: PALETTE.clones, backgroundColor: PALETTE.clones, tension: 0.25, pointRadius: 2 },
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
          { label: "Stars", data: growthDates.map(d => rec.growth[d].stars || 0), borderColor: PALETTE.stars, backgroundColor: PALETTE.stars, tension: 0.25, pointRadius: 2 },
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
    const repos = HISTORY.repos;
    const rows = Object.entries(repos).map(([name, rec]) => ({ name, rec, ...computeRepoTotals(rec) }));
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

    const body = document.createElement("div");
    body.className = "accordion-body";
    item.appendChild(header);
    item.appendChild(body);
    container.appendChild(item);
  });
}
