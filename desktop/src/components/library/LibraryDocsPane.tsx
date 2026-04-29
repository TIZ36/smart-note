import { useEffect, useMemo, useState } from "react";
import * as cloudApi from "@/lib/cloud-api";
import type { ChannelId } from "@/lib/types";

/* Library · Docs pane — wiki documents grouped by AI topic.
 *
 * Left tree: AI / Files mode toggle, then groups of documents.
 *   - AI mode: groups by metadata.smartnote_type → category → name
 *   - Files mode: flat list of names
 * Right pane: title bar + meta + actions (View raw / Re-enrich /
 * Copy as MCP) + chunk-level preview list.
 *
 * Phase 3 stub-real: tree fetches real documents; right pane shows
 * the document's name + byte size + metadata. Chunk-level viewer
 * lands in Phase 5 alongside the source viewer's full reuse.
 */

type Mode = "ai" | "files";

type Props = {
  onOpenSource: (channel: ChannelId) => void;
};

export function LibraryDocsPane({ onOpenSource }: Props) {
  const [docs, setDocs] = useState<cloudApi.CloudDocument[] | null>(null);
  const [mode, setMode] = useState<Mode>("ai");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) setDocs([]);
          return;
        }
        const res = await cloudApi.listDocuments();
        if (alive) setDocs(res.documents);
      } catch {
        if (alive) setDocs([]);
      }
    }
    load();
  }, []);

  const filtered = useMemo(() => {
    if (!docs) return [];
    if (!filter.trim()) return docs;
    const q = filter.toLowerCase();
    return docs.filter((d) => d.name.toLowerCase().includes(q));
  }, [docs, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, cloudApi.CloudDocument[]>();
    for (const d of filtered) {
      const key = mode === "ai"
        ? (typeof d.metadata?.smartnote_type === "string"
            ? d.metadata.smartnote_type
            : d.kind || "Other")
        : "All files";
      const list = map.get(key) || [];
      list.push(d);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, mode]);

  const active = filtered.find((d) => d.id === activeId) || filtered[0];

  return (
    <div className="proto-library-pane-cols">
      {/* Left tree */}
      <aside className="proto-library-tree">
        <div className="proto-library-tree-bar">
          <input
            className="proto-library-tree-search"
            placeholder="Filter topics…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="proto-library-tree-mode" role="tablist" aria-label="Tree mode">
            <button
              type="button"
              aria-pressed={mode === "ai"}
              title="AI-classified topics"
              onClick={() => setMode("ai")}
            >
              AI
            </button>
            <button
              type="button"
              aria-pressed={mode === "files"}
              title="Filesystem mirror"
              onClick={() => setMode("files")}
            >
              Files
            </button>
          </span>
        </div>
        <div className="proto-library-tree-scroll">
          {docs === null && (
            <div style={{ padding: 12, fontSize: 11, color: "var(--color-text-muted)" }}>
              loading…
            </div>
          )}
          {docs !== null && filtered.length === 0 && (
            <div style={{ padding: 12, fontSize: 11, color: "var(--color-text-muted)" }}>
              No documents yet. Ingest a note or sync a wiki folder.
            </div>
          )}
          {grouped.map(([groupName, items]) => (
            <div key={groupName}>
              <div className="proto-library-group">
                <span>{groupName}</span>
                <span className="proto-library-group-count">{items.length}</span>
              </div>
              {items.map((d) => (
                <button
                  type="button"
                  key={d.id}
                  className="proto-library-tree-item"
                  aria-current={d.id === (active?.id ?? "")}
                  onClick={() => setActiveId(d.id)}
                >
                  <span className="proto-library-tree-item-name">{d.name}</span>
                  <span className="proto-library-tree-item-count">
                    {Math.round(d.byte_size / 1024)}k
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      {/* Right content */}
      <div className="proto-library-content">
        {active ? (
          <>
            <div className="proto-library-content-bar">
              <div className="proto-library-content-title">{active.name}</div>
              <div className="proto-library-content-meta">
                {Math.round(active.byte_size / 1024)} KB · {active.kind}
                {active.ingested_at && " · ingested"}
              </div>
              <div className="proto-library-content-actions">
                <button
                  type="button"
                  className="proto-library-btn"
                  title="View original markdown"
                  onClick={() => onOpenSource(`source:${active.id}` as ChannelId)}
                >
                  View raw ↗
                </button>
                <button type="button" className="proto-library-btn">Re-enrich</button>
                <button type="button" className="proto-library-btn">Copy as MCP</button>
              </div>
            </div>
            <div className="proto-library-content-scroll">
              <div className="proto-library-card-list">
                <div className="proto-doc-card">
                  <div className="proto-doc-card-head">
                    <div className="proto-doc-card-title">Document metadata</div>
                    <div className="proto-doc-card-meta">{active.id.slice(0, 8)}</div>
                  </div>
                  <div className="proto-doc-card-snippet">
                    Created {fmtDate(active.created_at)}
                    {active.updated_at && ` · updated ${fmtDate(active.updated_at)}`}
                    {active.ingested_at
                      ? ` · ingested ${fmtDate(active.ingested_at)}`
                      : " · not yet ingested"}
                  </div>
                  {active.metadata && Object.keys(active.metadata).length > 0 && (
                    <div className="proto-doc-card-tags">
                      {Object.entries(active.metadata)
                        .filter(([, v]) => typeof v === "string")
                        .slice(0, 6)
                        .map(([k, v]) => (
                          <span key={k} className="proto-tag">
                            {k}: {String(v)}
                          </span>
                        ))}
                    </div>
                  )}
                </div>
                <div
                  className="proto-doc-card"
                  style={{ borderStyle: "dashed", cursor: "default" }}
                >
                  <div className="proto-doc-card-snippet" style={{ color: "var(--color-text-muted)" }}>
                    Chunk-level preview lands in Phase 5 alongside the source-file viewer.
                    For now the View raw ↗ button opens the original markdown in this surface.
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="proto-library-empty">
            Select a document on the left, or ingest a note from the Note tab.
          </div>
        )}
      </div>
    </div>
  );
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}
