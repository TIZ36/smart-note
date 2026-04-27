import { useEffect, useState } from "react";
import { fetchOverview, type ConsoleOverview } from "@/lib/cloud-api";

export function OverviewTab() {
  const [data, setData] = useState<ConsoleOverview | null>(null);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchOverview()
        .then((d) => { if (alive) { setData(d); setErr(""); } })
        .catch((e) => { if (alive) setErr(String(e)); });
    load();
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (err) {
    return (
      <div className="proto-cc-content">
        <div className="proto-cc-error">{err}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="proto-cc-content">
        <div className="proto-cc-empty">Loading…</div>
      </div>
    );
  }

  const { counts, executors, primary_device_online, activity } = data;

  return (
    <div className="proto-cc-content">
      <section className="proto-form-section">
        <div className="proto-cc-section-head">
          <h2 className="proto-form-section-title">Counts</h2>
        </div>
        <div className="proto-cc-grid">
          {([
            ["Memories", counts.memories],
            ["Documents", counts.documents],
            ["Devices", counts.devices],
            ["Wiki nodes", counts.wiki_nodes],
            ["Enrich queued", counts.enrich_queued],
            ["Enrich done", counts.enrich_done],
            ["Drafts", counts.proposals_pending],
          ] as const).map(([label, v]) => (
            <div key={label} className="proto-cc-card">
              <div className="proto-cc-card-label">{label}</div>
              <div className="proto-cc-card-value">{v}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="proto-form-divider" />

      <section className="proto-form-section">
        <div className="proto-cc-section-head">
          <h2 className="proto-form-section-title">Executors</h2>
        </div>
        <div className="proto-cc-row" style={{ flexWrap: "wrap", rowGap: 8 }}>
          <Status on={executors.mcp_pull} label="MCP pull · CC plan" />
          <Status on={executors.ws_relay} label="WS relay · primary device" />
          <Status on={executors.cloud_pool} label="Cloud pool · subscription" />
        </div>
      </section>

      <div className="proto-form-divider" />

      <section className="proto-form-section">
        <div className="proto-cc-section-head">
          <h2 className="proto-form-section-title">Primary device</h2>
        </div>
        <Status on={primary_device_online} label={primary_device_online ? "Online" : "Offline"} />
      </section>

      <div className="proto-form-divider" />

      <section className="proto-form-section">
        <div className="proto-cc-section-head">
          <h2 className="proto-form-section-title">Recent activity</h2>
        </div>
        {activity.length === 0 ? (
          <div className="proto-cc-empty">No recent activity.</div>
        ) : (
          <ul className="proto-cc-activity">
            {activity.map((a) => (
              <li key={a.id}>
                <span className="proto-cc-activity-kind">{a.kind}</span>
                <span className="proto-cc-activity-summary">{a.summary}</span>
                <span className="proto-cc-activity-time">{relativeTime(a.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Status({ on, label }: { on: boolean; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      <span className={"proto-cc-statusdot " + (on ? "proto-cc-statusdot-on" : "")} />
      {label}
    </span>
  );
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleDateString();
}
