import { useCallback, useEffect, useState } from "react";
import { listEnrichJobs, type EnrichJob } from "@/lib/cloud-api";

const STATUSES = ["all", "queued", "running", "done", "failed"] as const;
type StatusFilter = (typeof STATUSES)[number];

export function EnrichTab() {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [jobs, setJobs] = useState<EnrichJob[]>([]);
  const [err, setErr] = useState("");

  const refresh = useCallback(async () => {
    try {
      setJobs(await listEnrichJobs(filter === "all" ? undefined : filter));
      setErr("");
    } catch (e) { setErr(String(e)); }
  }, [filter]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  const tally = (st: string) => jobs.filter(j => j.status === st).length;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3">
        <h3 className="text-sm uppercase tracking-wide text-zinc-400">Enrich jobs</h3>
        <div className="flex gap-1 ml-auto">
          {STATUSES.map(s => (
            <button key={s} onClick={() => setFilter(s)}
              className={"text-xs px-2 py-1 rounded " +
                (filter === s ? "bg-emerald-700 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700")}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-sm">
        {(["queued", "running", "done", "failed"] as const).map(st => (
          <div key={st} className="bg-zinc-900/60 border border-zinc-800 rounded px-3 py-2">
            <div className="text-xs text-zinc-500">{st}</div>
            <div className="text-lg text-zinc-100">{tally(st)}</div>
          </div>
        ))}
      </div>

      {err && <div className="text-rose-400 text-sm">{err}</div>}

      {jobs.length === 0
        ? <div className="text-zinc-500 text-sm">No jobs.</div>
        : <table className="w-full text-sm">
            <thead className="text-zinc-500 text-xs uppercase">
              <tr>
                <th className="text-left py-1">Job</th>
                <th className="text-left">Status</th>
                <th className="text-left">Executor</th>
                <th className="text-left">Created</th>
                <th className="text-left">Finished</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(j => (
                <tr key={j.id} className="border-t border-zinc-800">
                  <td className="py-1 font-mono text-xs text-zinc-400">{j.id.slice(0, 8)}</td>
                  <td>
                    <span className={
                      j.status === "done" ? "text-emerald-400"
                      : j.status === "failed" ? "text-rose-400"
                      : j.status === "running" ? "text-amber-400"
                      : "text-zinc-400"
                    }>{j.status}</span>
                  </td>
                  <td>{j.executor || "—"}</td>
                  <td className="text-zinc-500">{new Date(j.created_at).toLocaleString()}</td>
                  <td className="text-zinc-500">{j.finished_at ? new Date(j.finished_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>}
    </div>
  );
}
