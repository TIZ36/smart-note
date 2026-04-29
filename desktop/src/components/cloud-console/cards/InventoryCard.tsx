import { useEffect, useState } from "react";
import { fetchOverview, type ConsoleOverview } from "@/lib/cloud-api";

/* Cloud knowledge inventory — what's actually in the workspace right
   now. Replaces the sprawling Overview tab; lives in Sync as a single
   readable strip the user glances at before deciding to push. */

const ITEMS = [
  { key: "notes", label: "Notes", get: (c: ConsoleOverview["counts"]) => c.notes },
  { key: "wiki", label: "Wiki topics", get: (c: ConsoleOverview["counts"]) => c.wiki_topics },
  { key: "tags", label: "AI tags", get: (c: ConsoleOverview["counts"]) => c.ai_tags },
  { key: "segs", label: "Tag segments", get: (c: ConsoleOverview["counts"]) => c.tag_segments },
  { key: "mems", label: "Memories", get: (c: ConsoleOverview["counts"]) => c.memories },
] as const;

export function InventoryCard() {
  const [data, setData] = useState<ConsoleOverview | null>(null);
  const [err, setErr] = useState("");

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

  return (
    <section className="proto-cloud-sync-card">
      <h2 className="proto-cloud-sync-card-title">Cloud knowledge</h2>
      <p className="proto-form-hint" style={{ marginBottom: 12 }}>
        What's stored on the server right now. Updates every 10s.
      </p>

      {err && <div className="proto-cc-error">{err}</div>}

      <div className="proto-inventory-grid">
        {ITEMS.map((it) => {
          const v = data ? it.get(data.counts) : null;
          return (
            <div key={it.key} className="proto-inventory-cell">
              <div className="proto-inventory-cell-value">
                {v == null ? "—" : v.toLocaleString()}
              </div>
              <div className="proto-inventory-cell-label">{it.label}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
