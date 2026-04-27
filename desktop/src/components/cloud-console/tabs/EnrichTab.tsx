import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { listEnrichJobs, type EnrichJob } from "@/lib/cloud-api";

const STATUSES = ["all", "queued", "running", "done", "failed"] as const;
type StatusFilter = (typeof STATUSES)[number];

export function EnrichTab() {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [jobs, setJobs] = useState<EnrichJob[]>([]);
  const [err, setErr] = useState("");

  const refresh = useCallback(async () => {
    try { setJobs(await listEnrichJobs(filter === "all" ? undefined : filter)); setErr(""); }
    catch (e) { setErr(String(e)); }
  }, [filter]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  const tally = (st: string) => jobs.filter((j) => j.status === st).length;

  return (
    <div className="proto-cc-content">
      <section className="proto-form-section">
        <div className="proto-cc-section-head">
          <h2 className="proto-form-section-title">Enrich jobs</h2>
          <div style={{ display: "flex", gap: 2 }}>
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFilter(s)}
                className={cn("proto-cc-tab", filter === s && "proto-cc-tab-active")}
                style={{ height: 26, padding: "0 10px", fontSize: 12 }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="proto-cc-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 16 }}>
          {(["queued", "running", "done", "failed"] as const).map((st) => (
            <div key={st} className="proto-cc-card">
              <div className="proto-cc-card-label">{st}</div>
              <div className="proto-cc-card-value">{tally(st)}</div>
            </div>
          ))}
        </div>

        {err && <div className="proto-cc-error">{err}</div>}

        {jobs.length === 0 ? (
          <div className="proto-cc-empty">No jobs.</div>
        ) : (
          <table className="proto-cc-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Executor</th>
                <th>Created</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="proto-cc-cell-mono">{j.id.slice(0, 8)}</td>
                  <td>
                    <span className={cn("proto-cc-status-badge", `proto-cc-status-badge-${j.status}`)}>
                      {j.status}
                    </span>
                  </td>
                  <td className="proto-cc-cell-muted">{j.executor || "—"}</td>
                  <td className="proto-cc-cell-muted">{new Date(j.created_at).toLocaleString()}</td>
                  <td className="proto-cc-cell-muted">
                    {j.finished_at ? new Date(j.finished_at).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
