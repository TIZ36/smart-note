"use client";
import { useMemo, useState } from "react";
import { PageHead } from "@/components/PageHead";
import { useDetail } from "@/components/DetailOverlay";
import { IconChev, IconSearch } from "@/components/icons";
import { fetchRunDetail, fetchStats, listDocumentNames, listRuns } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, dotClass } from "@/lib/cn";
import type { Run } from "@/lib/types";

export default function ExecutionPage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const { open } = useDetail();

  // Recent_runs only carries document_id (UUID). Fetch the workspace
  // doc list in parallel so we can resolve UUIDs into file names — the
  // user's primary identifier in the row.
  const runsQ  = useApi(() => Promise.all([listRuns(50), listDocumentNames()]));
  const statsQ = useApi(() => fetchStats());

  const [rawRuns, nameMap] = runsQ.data ?? [[], new Map<string, string>()];
  const runs = useMemo(() =>
    rawRuns.map((r) => ({
      ...r,
      doc: (r.docId && nameMap.get(r.docId)) || r.doc,
    })),
    [rawRuns, nameMap],
  );
  const filtered = useMemo(() => runs.filter((r) =>
    (!q || (r.doc + r.stage + r.id).toLowerCase().includes(q.toLowerCase())) &&
    (!status || r.status === status)
  ), [runs, q, status]);

  const todayRuns = runs.filter((r) => r.bucket === "Today");
  const failedCount = statsQ.data?.failedToday ?? todayRuns.filter((r) => r.status === "failed").length;
  const runsTodayN  = statsQ.data?.runsToday   ?? todayRuns.length;
  const costToday   = statsQ.data?.costTodayUsd ?? 0;

  // Sparkline for "Runs today" — pad to 8 bars
  const sparkBars: { cls: "" | "hit" | "fail"; h: number }[] = [];
  for (let i = 0; i < 8 - todayRuns.length; i++) sparkBars.push({ cls: "", h: 3 });
  for (const r of todayRuns) {
    const h = r.status === "failed" ? 10 : r.status === "running" ? 12 : 8 + ((r.id.charCodeAt(4) || 5) % 7);
    sparkBars.push({ cls: r.status === "failed" ? "fail" : "hit", h });
  }

  function showRun(r: Run) {
    open({
      title: r.stage, mono: true,
      sub: r.docId ? r.doc : r.id,    // file name in the subtitle when known
      body: <RunDetailBody initial={r} runId={r.id} />,
    });
  }

  const grouped: (Run | { divider: string })[] = [];
  let last = "";
  for (const r of filtered) {
    if (r.bucket !== last) { grouped.push({ divider: r.bucket }); last = r.bucket; }
    grouped.push(r);
  }

  return (
    <div className="page">
      <PageHead section="execution" title="Execution log" liveTime />

      <section className="stats" aria-label="Today summary">
        <div className="stat">
          <span className="stat-value">{runsTodayN}</span>
          <span className="stat-label">Runs today</span>
          <div className="stat-spark">
            {sparkBars.map((b, i) => <span key={i} className={b.cls} style={{ height: b.h }} />)}
          </div>
        </div>
        <div className="stat">
          <span className={cn("stat-value", failedCount > 0 && "alert")}>{failedCount}</span>
          <span className="stat-label">Failed</span>
          <div className="stat-spark">
            {failedCount > 0 ? <span className="fail" /> : <span />}
            <span /><span /><span /><span /><span /><span /><span />
          </div>
        </div>
        <div className="stat">
          <span className="stat-value">
            {todayRuns.length ? avgDurationS(todayRuns) : "—"}
            <span className="stat-unit">s avg</span>
          </span>
          <span className="stat-label">Duration</span>
          <div className="stat-spark">
            {durationSpark(todayRuns).map((h, i) => <span key={i} className="hit" style={{ height: h }} />)}
          </div>
        </div>
        <div className="stat">
          <span className="stat-value">${costToday.toFixed(2)}</span>
          <span className="stat-label">Cost today</span>
          <div className="stat-spark">
            {[3, 6, 10, 4, 8, 13, 7, 5].map((h, i) => <span key={i} className={costToday > 0 ? "hit" : ""} style={{ height: h }} />)}
          </div>
        </div>
      </section>

      <div className="toolbar">
        <div className="toolbar-search">
          <IconSearch />
          <input placeholder="Search stage, document, run id…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All status</option>
          <option value="done">done</option>
          <option value="running">running</option>
          <option value="failed">failed</option>
        </select>
        <span className="toolbar-count">
          {runsQ.loading ? "loading…" : `${filtered.length} ${filtered.length === 1 ? "record" : "records"}`}
        </span>
      </div>

      <div className="colhead runs-cols">
        <span /><span>Action</span><span>File</span>
        <span className="ta-right">Result</span>
        <span className="ta-right">Time</span>
        <span className="ta-right">Duration</span>
        <span />
      </div>

      <div className="list">
        {runsQ.error   && <div className="empty">Failed to load: {runsQ.error}</div>}
        {!runsQ.error && !runsQ.loading && grouped.length === 0 && <div className="empty">No runs match.</div>}
        {grouped.map((item, i) =>
          "divider" in item ? (
            <div key={`d-${i}`} className="date-divider">{item.divider}</div>
          ) : (
            <button key={item.id} className="row runs-cols" onClick={() => showRun(item)} title={item.timeFull}>
              <span className={cn("row-dot", dotClass(item.status))} />
              <span className="row-stage">{item.stage}</span>
              <span className={cn("row-doc", !item.docId && "row-doc-untitled")}>
                {item.docId ? item.doc : "—"}
              </span>
              <span className={cn("row-result", dotClass(item.status))}>{item.status}</span>
              <span className="row-time">{item.time}</span>
              <span className="row-dur">{item.duration}</span>
              <span className="row-chev"><IconChev /></span>
            </button>
          )
        )}
      </div>

      <div className="keyhint">
        <span><kbd>esc</kbd> close detail</span>
        <span><kbd>/</kbd> focus search</span>
      </div>
    </div>
  );
}

function avgDurationS(runs: Run[]): string {
  const ms = runs
    .map((r) => parseDurationMs(r.duration))
    .filter((n): n is number => n != null);
  if (!ms.length) return "—";
  return ((ms.reduce((a, b) => a + b, 0) / ms.length) / 1000).toFixed(1);
}
function parseDurationMs(d: string): number | null {
  if (d === "—") return null;
  const m = d.match(/^([\d.]+)(ms|s|m)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (m[2] === "ms") return n;
  if (m[2] === "m")  return n * 60_000;
  return n * 1000;
}
function durationSpark(runs: Run[]): number[] {
  const ms = runs.map((r) => parseDurationMs(r.duration) ?? 0);
  const max = Math.max(1, ...ms);
  const bars = ms.map((v) => 3 + Math.round((v / max) * 12));
  while (bars.length < 8) bars.unshift(3);
  return bars.slice(-8);
}

// Lazy-loaded detail body — fetches the full chain on open.
function RunDetailBody({ initial, runId }: { initial: Run; runId: string }) {
  const { data, loading, error } = useApi(() => fetchRunDetail(runId), [runId]);
  // Prefer the page-resolved file name over the raw UUID the chain endpoint returns.
  const r = data?.run ? { ...data.run, doc: initial.doc } : initial;
  const events = data?.events ?? [];

  return (
    <>
      <section>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span className={cn("status-pill", dotClass(r.status))}><span className="d" />{r.status}</span>
          <span style={{ color: "var(--muted)", fontSize: 11.5 }}>{r.time} · {r.duration} · {r.cost}</span>
        </div>
        <dl className="kv">
          <dt>Document</dt><dd>{r.doc}</dd>
          <dt>Run ID</dt>  <dd className="mono">{r.id}</dd>
          <dt>Stage</dt>   <dd className="mono">{r.stage}</dd>
          {r.error && <><dt>Error</dt><dd style={{ color: "var(--danger)" }}>{r.error}</dd></>}
          {data?.model && <><dt>Model</dt><dd className="mono">{data.model}</dd></>}
        </dl>
      </section>
      <section>
        <h4>Timeline</h4>
        {loading && <div style={{ color: "var(--muted)", fontSize: 12 }}>loading events…</div>}
        {error && <div style={{ color: "var(--danger)", fontSize: 12 }}>failed: {error}</div>}
        {!loading && !error && events.length > 0 && (
          <div className="timeline">
            {events.map((e, i) => {
              const t = e.at ? new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "--:--:--";
              const cls = e.status === "failed" ? "s-failed" : e.status === "done" ? "s-done" : "s-running";
              return (
                <div key={i} className={`timeline-row ${cls}`}>
                  <span className="timeline-time">{t}</span>
                  <span className="timeline-body">
                    <b>{e.event || e.status || "event"}</b>
                    {e.message || e.error || (e.stage ? `stage ${e.stage}` : "")}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <section>
        <h4>Raw log</h4>
        <pre
          className="log-block"
          dangerouslySetInnerHTML={{ __html: r.log.replace(/FAILED[^\n]*/g, (m) => `<span class="log-fail">${m}</span>`) }}
        />
      </section>
    </>
  );
}
