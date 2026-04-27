import { useEffect, useState } from "react";
import { fetchOverview, type ConsoleOverview } from "@/lib/cloud-api";

export function OverviewTab() {
  const [data, setData] = useState<ConsoleOverview | null>(null);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    let alive = true;
    const load = () => fetchOverview()
      .then(d => { if (alive) { setData(d); setErr(""); } })
      .catch(e => { if (alive) setErr(String(e)); });
    load();
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (err) return <div className="p-4 text-rose-400">{err}</div>;
  if (!data) return <div className="p-4 text-zinc-400">Loading…</div>;

  const { counts, executors, primary_device_online, activity } = data;
  const dot = (on: boolean) => (
    <span className={"inline-block w-2 h-2 rounded-full mr-2 " +
      (on ? "bg-emerald-400" : "bg-zinc-600")} />
  );

  return (
    <div className="p-4 space-y-4">
      <section>
        <h3 className="text-sm uppercase tracking-wide text-zinc-400 mb-2">Counts</h3>
        <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
          {([
            ["Memories", counts.memories],
            ["Documents", counts.documents],
            ["Devices", counts.devices],
            ["Wiki nodes", counts.wiki_nodes],
            ["Enrich queued", counts.enrich_queued],
            ["Enrich done", counts.enrich_done],
            ["Drafts", counts.proposals_pending],
          ] as const).map(([label, v]) => (
            <div key={label} className="bg-zinc-900/60 border border-zinc-800 rounded px-3 py-2">
              <div className="text-xs text-zinc-500">{label}</div>
              <div className="text-lg text-zinc-100">{v}</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-sm uppercase tracking-wide text-zinc-400 mb-2">Executors</h3>
        <div className="flex gap-4 text-sm">
          <span>{dot(executors.mcp_pull)}MCP pull (CC plan)</span>
          <span>{dot(executors.ws_relay)}WS relay (primary device)</span>
          <span>{dot(executors.cloud_pool)}Cloud pool (subscription)</span>
        </div>
      </section>

      <section>
        <h3 className="text-sm uppercase tracking-wide text-zinc-400 mb-2">Primary device</h3>
        <div className="text-sm">{dot(primary_device_online)}{primary_device_online ? "Online" : "Offline"}</div>
      </section>

      <section>
        <h3 className="text-sm uppercase tracking-wide text-zinc-400 mb-2">Recent activity</h3>
        {activity.length === 0
          ? <div className="text-zinc-500 text-sm">No recent activity.</div>
          : <ul className="space-y-1">
              {activity.map(a => (
                <li key={a.id} className="text-sm text-zinc-300">
                  <span className="text-zinc-500">[{a.kind}]</span> {a.summary}
                  <span className="text-zinc-600 ml-2">{new Date(a.at).toLocaleString()}</span>
                </li>
              ))}
            </ul>}
      </section>
    </div>
  );
}
