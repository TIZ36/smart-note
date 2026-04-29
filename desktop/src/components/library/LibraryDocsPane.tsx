import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, Trash2, Tag } from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import type { ChannelId } from "@/lib/types";

// 3-tier kind: note (synced personal) · wiki_topic (topical
// reference) · doc (untyped — user can re-classify via Set type).
type DocKind = "note" | "wiki_topic" | "doc";

function kindOf(d: cloudApi.CloudDocument): DocKind {
  const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
  const snt = String(md.smartnote_type || "");
  if (snt === "wiki_topic") return "wiki_topic";
  if (snt === "note") return "note";
  return "doc";
}

function kindLabel(k: DocKind): string {
  if (k === "wiki_topic") return "Wiki topic";
  if (k === "note") return "Note";
  return "Doc";
}

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
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function reload() {
    try {
      if (!(await cloudApi.isCloudConfigured())) {
        setDocs([]);
        return;
      }
      const res = await cloudApi.listDocuments();
      setDocs(res.documents);
    } catch {
      setDocs([]);
    }
  }

  useEffect(() => { reload(); }, []);

  // Import: pick one or more text/markdown files, upload each as a
  // CloudDocument with smartnote_type=wiki_topic so it lands in the
  // wiki tree (and the chapter splitter applies tag_meta on ingest).
  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setBusy("import");
    let ok = 0;
    let lastId: string | null = null;
    for (const f of files) {
      try {
        const content = await f.text();
        const created = await cloudApi.createDocument({
          name: f.name.replace(/\.(md|txt)$/i, ""),
          content,
          kind: "markdown",
          metadata: { smartnote_type: "wiki_topic", imported_at: new Date().toISOString() },
        });
        lastId = created.id;
        ok++;
      } catch {
        /* per-file tolerant */
      }
    }
    setBusy(null);
    if (fileRef.current) fileRef.current.value = "";
    await reload();
    if (lastId) setActiveId(lastId);
    if (ok < files.length) {
      window.alert(`Imported ${ok}/${files.length}. ${files.length - ok} failed (cloud unreachable?).`);
    }
  }

  async function handleDelete() {
    if (!active) return;
    if (!window.confirm(`Delete "${active.name}"? Chunks + memories tied to this document are also dropped.`)) return;
    setBusy("delete");
    try {
      await cloudApi.deleteDocument(active.id);
      setActiveId(null);
      await reload();
    } catch (e) {
      window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

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
        // Friendly label per 3-tier kind. Uncategorized goes to
        // "Docs" so user sees them as a separate bucket and can
        // re-classify via the Set type action.
        ? (kindOf(d) === "wiki_topic" ? "Wiki topics"
          : kindOf(d) === "note"      ? "Notes"
          :                              "Docs · uncategorized")
        : "All files";
      const list = map.get(key) || [];
      list.push(d);
      map.set(key, list);
    }
    // Stable sort: Notes → Wiki → Docs → other when in AI mode.
    const order = ["Notes", "Wiki topics", "Docs · uncategorized"];
    return Array.from(map.entries()).sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      if (ai !== -1 || bi !== -1) {
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      }
      return a[0].localeCompare(b[0]);
    });
  }, [filtered, mode]);

  // Re-classify the active document by setting metadata.smartnote_type.
  // Existing metadata is merged so we don't drop other fields like
  // ai_tags, relative_path, imported_at, etc.
  async function setKind(target: DocKind) {
    if (!active) return;
    setBusy("retype");
    try {
      const md = (active.metadata && typeof active.metadata === "object"
        ? { ...active.metadata }
        : {}) as Record<string, unknown>;
      if (target === "doc") {
        delete md.smartnote_type;
      } else {
        md.smartnote_type = target;
      }
      await cloudApi.patchDocument(active.id, { metadata: md });
      await reload();
    } catch (e) {
      window.alert(`Re-classify failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

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
        {/* Import — pick one or more .md / .txt files and upload as
            wiki_topic documents. Chapter splitter applies tag-meta
            on ingest so they're query-ready immediately. */}
        <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--color-border)" }}>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.txt,.markdown"
            multiple
            style={{ display: "none" }}
            onChange={handleImport}
          />
          <button
            type="button"
            className="proto-library-btn"
            disabled={busy === "import"}
            onClick={() => fileRef.current?.click()}
            style={{ width: "100%", justifyContent: "center" }}
            title="Pick markdown / text files to import as wiki documents"
          >
            <Upload size={11} strokeWidth={2} />
            {busy === "import" ? "Uploading…" : "Import files"}
          </button>
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
                {kindLabel(kindOf(active))} · {Math.round(active.byte_size / 1024)} KB
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
                {/* Re-classify dropdown — reads current kind, lets
                    user set note / wiki / doc. Persists by patching
                    metadata.smartnote_type. */}
                <span className="proto-library-set-type">
                  <Tag size={11} strokeWidth={2} />
                  <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Type:</span>
                  <select
                    className="proto-library-set-type-select"
                    value={kindOf(active)}
                    disabled={busy === "retype"}
                    onChange={(e) => setKind(e.target.value as DocKind)}
                    title="Re-classify this document"
                  >
                    <option value="note">Note</option>
                    <option value="wiki_topic">Wiki topic</option>
                    <option value="doc">Doc (uncategorized)</option>
                  </select>
                </span>
                <button
                  type="button"
                  className="proto-library-btn"
                  disabled={busy === "delete"}
                  onClick={handleDelete}
                  title={`Delete "${active.name}" from the workspace`}
                  style={{ color: "var(--color-danger)", borderColor: "color-mix(in oklab, var(--color-danger) 30%, var(--color-border))" }}
                >
                  <Trash2 size={11} strokeWidth={2} />
                  {busy === "delete" ? "Deleting…" : "Delete"}
                </button>
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
