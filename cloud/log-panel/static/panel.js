/* SmartNote Log Panel — front-end controller (developer tool).
 *
 * Vanilla JS. Talks directly to the panel's own /api/* endpoints,
 * which read pipeline_events from Postgres. No auth — internal tool.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STATE = {
  list: [],
  listMode: "recent",
  selectedRunId: null,
};

/* ───── Theme ───── */
$$(".theme-toggle button").forEach(b => b.addEventListener("click", () => {
  document.documentElement.setAttribute("data-theme", b.dataset.themeSet);
  $$(".theme-toggle button").forEach(x => x.setAttribute("aria-pressed", x === b));
}));

/* ───── Helpers ───── */
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return ms + "ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 1000) + "s";
}
function fmtUsd(n) {
  if (n == null) return "—";
  if (n >= 1) return "$" + n.toFixed(2);
  if (n >= 0.01) return "$" + n.toFixed(3);
  return "$" + n.toFixed(4);
}
function fmtBytes(n) {
  if (!n && n !== 0) return "—";
  return n.toLocaleString();
}
function shortId(id) {
  if (!id) return "—";
  return id.slice(0, 8);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function syntaxJson(obj) {
  const json = JSON.stringify(obj, null, 2);
  return json
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>')
    .replace(/: (-?\d+\.?\d*)/g, ': <span class="n">$1</span>')
    .replace(/: (true|false|null)/g, ': <span class="b">$1</span>');
}

async function api(path, params) {
  const url = new URL("/api/" + path.replace(/^\//, ""), window.location.origin);
  if (params) for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const r = await fetch(url);
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`${r.status} — ${detail.slice(0, 200)}`);
  }
  return r.json();
}

/* ───── Health ───── */
async function loadHealth() {
  try {
    const r = await fetch("/health");
    const j = await r.json();
    $("#cloud-info").textContent = j.db_connected ? "db · connected" : "db · " + (j.db_configured ? "down" : "no DATABASE_URL");
  } catch {
    $("#cloud-info").textContent = "panel offline";
  }
}

/* ───── Stats ───── */
async function loadStats() {
  try {
    const j = await api("stats");
    $("#s-runs-24").textContent = j.runs_24h.toLocaleString();
    $("#s-events-24").textContent = j.events_24h.toLocaleString();
    $("#s-errors-24").textContent = j.errors_24h.toLocaleString();
    $("#s-ws-24").textContent = j.workspaces_24h;
    $("#s-cost-24").textContent = fmtUsd(j.cost_24h_usd);
    $("#s-errors-24").parentElement.classList.toggle("warn", j.errors_24h > 0);
    $("#s-cost-24").parentElement.classList.add("cost");
  } catch (e) {
    console.warn("stats failed", e);
  }
}

/* ───── Workspaces dropdown ───── */
async function loadWorkspaces() {
  try {
    const j = await api("workspaces", { limit: 50 });
    const sel = $("#f-workspace");
    /* keep "all workspaces" option, replace rest */
    sel.innerHTML = `<option value="">all workspaces (${j.workspaces.length})</option>`;
    for (const w of j.workspaces) {
      const opt = document.createElement("option");
      opt.value = w.workspace_id;
      opt.textContent = `${shortId(w.workspace_id)} · ${w.events.toLocaleString()} events`;
      sel.appendChild(opt);
    }
  } catch (e) {
    console.warn("workspaces failed", e);
  }
}

/* ───── Recent runs list ───── */
async function loadRecent() {
  STATE.listMode = "recent";
  $("#list-title").textContent = "Recent runs";
  $("#list").innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const j = await api("recent_runs", {
      workspace_id: $("#f-workspace").value || undefined,
      limit: 50,
    });
    STATE.list = j.runs;
    $("#list-meta").textContent = `${j.runs.length} runs`;
    renderList();
  } catch (e) {
    $("#list").innerHTML = `<div class="empty">${escapeHtml(String(e))}</div>`;
  }
}

/* ───── Search ───── */
async function runSearch() {
  STATE.listMode = "search";
  $("#list-title").textContent = "Search results";
  $("#list").innerHTML = `<div class="empty">Searching…</div>`;
  const params = {
    q: $("#q").value.trim() || undefined,
    workspace_id: $("#f-workspace").value || undefined,
    stage: $("#f-stage").value || undefined,
    status: $("#f-status").value || undefined,
    limit: 200,
  };
  try {
    const j = await api("search", params);
    /* Roll up by run_id so the list is one row per run */
    const byRun = new Map();
    for (const ev of j.events) {
      const k = ev.run_id || `_evt:${ev.id}`;
      if (!byRun.has(k)) {
        byRun.set(k, {
          run_id: ev.run_id,
          workspace_id: ev.workspace_id,
          stage: ev.stage,
          status: ev.status,
          last_at: ev.at,
          first_at: ev.at,
          event_count: 1,
        });
      } else {
        const r = byRun.get(k);
        r.event_count++;
        if (ev.at > r.last_at) r.last_at = ev.at;
        if (ev.at < r.first_at) r.first_at = ev.at;
        if (["done","failed","partial","skipped"].includes(ev.status)) r.status = ev.status;
      }
    }
    STATE.list = Array.from(byRun.values()).sort((a, b) => b.last_at.localeCompare(a.last_at));
    $("#list-meta").textContent = `${j.events.length} events · ${STATE.list.length} runs`;
    renderList();
  } catch (e) {
    $("#list").innerHTML = `<div class="empty">${escapeHtml(String(e))}</div>`;
  }
}

function renderList() {
  if (!STATE.list.length) {
    $("#list").innerHTML = `<div class="empty">No runs match.</div>`;
    return;
  }
  $("#list").innerHTML = STATE.list.map(r => {
    const stageLabel = (r.stage || "—").replace(/_/g, " ");
    const status = r.status || "running";
    const idShort = r.run_id ? r.run_id.slice(0, 8) : "—";
    const wsShort = r.workspace_id ? r.workspace_id.slice(0, 6) : "";
    return `
      <button class="run-row" data-run-id="${r.run_id || ""}" aria-selected="${r.run_id === STATE.selectedRunId}">
        <span class="run-dot s-${status}" title="${status}"></span>
        <span class="run-name"><b>${escapeHtml(stageLabel)}</b> · ${idShort}<span class="ws">${wsShort}</span></span>
        <span class="run-meta">${fmtTime(r.last_at)}${r.duration_ms != null ? " · " + fmtDuration(r.duration_ms) : ""}</span>
      </button>
    `;
  }).join("");
  $$(".run-row").forEach(b => b.addEventListener("click", () => {
    const id = b.dataset.runId;
    if (!id) return;
    selectRun(id);
  }));
}

/* ───── Detail ───── */
async function selectRun(runId) {
  STATE.selectedRunId = runId;
  $$(".run-row").forEach(b => b.setAttribute("aria-selected", b.dataset.runId === runId));
  const u = new URL(window.location.href);
  u.searchParams.set("run", runId);
  history.replaceState(null, "", u.toString());

  $("#detail").innerHTML = `<div class="empty-state"><h2>Loading…</h2></div>`;
  try {
    const r = await api(`runs/${encodeURIComponent(runId)}`);
    renderRun(r);
  } catch (e) {
    $("#detail").innerHTML = `<div class="empty-state"><h2>Couldn't load run</h2><p>${escapeHtml(String(e))}</p></div>`;
  }
}

function renderRun(r) {
  const status = r.status || "running";
  const stage = r.stage || "—";
  const events = r.events || [];

  const card = `
    <div class="run-card s-${status}">
      <div class="run-card-head">
        <div class="run-card-stamp">${(stage[0] || "·").toUpperCase()}</div>
        <div class="run-card-titles">
          <div class="run-card-eyebrow">${escapeHtml(stage)} · ${events.length} events</div>
          <h2 class="run-card-title">${escapeHtml(r.run_id)}</h2>
          <div class="run-card-sub">
            <span class="event-status s-${status}">${status.toUpperCase()}</span>
            ${r.model ? "&nbsp; " + escapeHtml(r.model) : ""}
            ${r.duration_ms != null ? "&nbsp; " + fmtDuration(r.duration_ms) : ""}
            ${r.cost_usd != null ? "&nbsp; " + fmtUsd(r.cost_usd) : ""}
          </div>
        </div>
      </div>
      <dl class="kv">
        <dt>workspace</dt><dd>${r.workspace_id ? escapeHtml(r.workspace_id) : "—"}</dd>
        <dt>document</dt> <dd>${r.document_id ? escapeHtml(r.document_id) : "—"}</dd>
        <dt>started</dt>  <dd>${fmtDate(r.started_at)}</dd>
        <dt>finished</dt> <dd>${fmtDate(r.finished_at)}</dd>
        <dt>duration</dt> <dd>${fmtDuration(r.duration_ms)}</dd>
        ${r.cost_usd != null ? `<dt>cost</dt><dd>${fmtUsd(r.cost_usd)}${r.model ? " · " + escapeHtml(r.model) : ""}</dd>` : ""}
      </dl>
    </div>`;

  const timeline = `
    <div class="timeline">
      <div class="timeline-head">
        Event timeline <span class="meta">${events.length} events</span>
      </div>
      ${events.map(renderEvent).join("")}
    </div>
  `;

  $("#detail").innerHTML = card + timeline;
}

function renderEvent(ev) {
  const status = ev.status || "—";
  const data = ev.data || {};
  const summary = [];
  if (data.cost_usd != null) summary.push(`<span><b>cost</b> ${fmtUsd(data.cost_usd)}</span>`);
  if (data.model) summary.push(`<span><b>model</b> ${escapeHtml(data.model)}</span>`);
  if (data.input_tokens != null) summary.push(`<span><b>in</b> ${fmtBytes(data.input_tokens)}</span>`);
  if (data.output_tokens != null) summary.push(`<span><b>out</b> ${fmtBytes(data.output_tokens)}</span>`);
  if (data.duration_ms != null) summary.push(`<span><b>dur</b> ${fmtDuration(data.duration_ms)}</span>`);
  if (data.segments_count != null) summary.push(`<span><b>segments</b> ${data.segments_count}</span>`);
  if (data.chapters != null) summary.push(`<span><b>chapters</b> ${data.chapters}</span>`);
  if (data.progress) summary.push(`<span><b>progress</b> ${data.progress.current}/${data.progress.total}</span>`);
  if (data.executor) summary.push(`<span><b>executor</b> ${escapeHtml(data.executor)}</span>`);
  if (data.mode) summary.push(`<span><b>mode</b> ${escapeHtml(data.mode)}</span>`);

  return `
    <div class="event s-${status}">
      <span class="event-time">${fmtTime(ev.at)}</span>
      <span class="event-dot"></span>
      <div class="event-body">
        <div class="event-row">
          <span class="event-name">${escapeHtml(ev.event)}</span>
          <span class="event-status s-${status}">${status.toUpperCase()}</span>
        </div>
        ${ev.message ? `<div class="event-msg">${escapeHtml(ev.message)}</div>` : ""}
        ${ev.error ? `<div class="event-err">${escapeHtml(ev.error)}</div>` : ""}
        ${summary.length ? `<div class="event-data">${summary.join("")}</div>` : ""}
        ${Object.keys(data).length ? `
          <details class="json-disclose">
            <summary>raw payload (${Object.keys(data).length} keys)</summary>
            <pre>${syntaxJson(data)}</pre>
          </details>` : ""}
      </div>
    </div>
  `;
}

/* ───── Wiring ───── */
$("#btn-search").addEventListener("click", runSearch);
$("#btn-recent").addEventListener("click", loadRecent);
$("#btn-refresh").addEventListener("click", () => {
  loadHealth(); loadStats(); loadWorkspaces();
  if (STATE.listMode === "search") runSearch(); else loadRecent();
});
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") runSearch(); });
$("#f-workspace").addEventListener("change", () => {
  if (STATE.listMode === "search") runSearch(); else loadRecent();
});

(async function boot() {
  await loadHealth();
  await loadStats();
  await loadWorkspaces();
  await loadRecent();
  const u = new URL(window.location.href);
  const runParam = u.searchParams.get("run");
  if (runParam) selectRun(runParam);
})();
