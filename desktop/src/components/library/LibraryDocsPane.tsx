import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, Trash2, Tag, Copy, Sparkles, FileText, Layers } from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { cn } from "@/lib/cn";
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
type ViewMode = "raw" | "kn";

type Props = {
  onOpenSource: (channel: ChannelId) => void;
};

export function LibraryDocsPane({ onOpenSource }: Props) {
  const [docs, setDocs] = useState<cloudApi.CloudDocument[] | null>(null);
  const [mode, setMode] = useState<Mode>("ai");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("raw");
  const [rawContent, setRawContent] = useState<string | null>(null);
  const [copiedRef, setCopiedRef] = useState(false);
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

  // Fetch the doc's full markdown body when the active selection
  // changes. Cache result keyed by doc id so flipping back from KN
  // mode doesn't re-fetch.
  useEffect(() => {
    if (!activeId) { setRawContent(null); return; }
    let alive = true;
    setRawContent(null);
    cloudApi.getDocument(activeId)
      .then((d) => alive && setRawContent(d.content || ""))
      .catch(() => alive && setRawContent("(failed to load content — cloud unreachable?)"));
    return () => { alive = false; };
  }, [activeId]);

  // Direct reference — a stable URI that, when pasted into a Claude /
  // Cursor prompt, lets the agent resolve THIS exact document via
  // SmartNote MCP. Uses smartnote:// scheme + full UUID for unambiguity
  // + name slug for human readability. Keeping the format pattern-
  // matchable so the MCP server can intercept via a regex tool.
  function buildDirectRef(d: cloudApi.CloudDocument): string {
    const slug = d.name
      .toLowerCase()
      .replace(/[\s/]+/g, "-")
      .replace(/[^\w一-鿿\-_.]/g, "")
      .slice(0, 60);
    return `@smartnote://doc/${d.id}/${slug}`;
  }
  async function handleCopyDirectRef() {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(buildDirectRef(active));
      setCopiedRef(true);
      setTimeout(() => setCopiedRef(false), 1600);
    } catch {
      window.alert(buildDirectRef(active));
    }
  }

  // Wiki smartsheet trigger (chapter-based concept extraction).
  // Calls the cloud's /v1/wiki-smartsheet/{id}/build endpoint —
  // distinct from generic enrich because it produces a structured
  // table per chapter (entities × claims × refs) rather than line-
  // level tag classifications. For now backend is a skeleton; the
  // button surface is wired so users have a clear path.
  async function handleBuildSmartsheet() {
    if (!active) return;
    setBusy("smartsheet");
    try {
      // Optimistic — the endpoint is being added in a parallel
      // backend commit. Until it lands the call will 404; we surface
      // a clear message rather than failing silently.
      await cloudApi.buildWikiSmartsheet(active.id);
      window.alert("Wiki smartsheet queued. Refresh to see chapters.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("404") || msg.includes("not found")) {
        window.alert("Wiki smartsheet endpoint not deployed yet — coming next cloud release.");
      } else {
        window.alert(`Smartsheet build failed: ${msg}`);
      }
    } finally {
      setBusy(null);
    }
  }

  // Generic re-enrich (LLM classifier + tag generation per line).
  async function handleReEnrich() {
    if (!active) return;
    setBusy("enrich");
    try {
      await cloudApi.runEnrich(active.id);
      window.alert("Enrich job queued. Watch progress in KP / Library Memories.");
    } catch (e) {
      window.alert(`Enrich failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

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
                {/* Raw / KN view-mode toggle. Raw = source markdown
                    read-only (default); KN = knowledge view with
                    pipeline status, chunks, smartsheet (for wiki). */}
                <span className="proto-library-view-toggle" role="tablist" aria-label="View mode">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "raw"}
                    onClick={() => setViewMode("raw")}
                    title="Source markdown (read-only)"
                  >
                    <FileText size={11} strokeWidth={2} /> Raw
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "kn"}
                    onClick={() => setViewMode("kn")}
                    title="Knowledge view: pipeline status + chunks + smartsheet"
                  >
                    <Layers size={11} strokeWidth={2} /> KN
                  </button>
                </span>

                {/* Enrich vs wiki-smartsheet — wiki kind gets the
                    chapter-based concept extraction button instead
                    of generic Re-enrich (which does line-level tags). */}
                {kindOf(active) === "wiki_topic" ? (
                  <button
                    type="button"
                    className="proto-library-btn"
                    disabled={busy === "smartsheet"}
                    onClick={handleBuildSmartsheet}
                    title="Build chapter-based concept matrix (entities × claims × refs per chapter)"
                  >
                    <Sparkles size={11} strokeWidth={2} />
                    {busy === "smartsheet" ? "Building…" : "Build wiki-smartsheet"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="proto-library-btn"
                    disabled={busy === "enrich"}
                    onClick={handleReEnrich}
                    title="LLM classifier + tag generation per line"
                  >
                    <Sparkles size={11} strokeWidth={2} />
                    {busy === "enrich" ? "Enriching…" : "Re-enrich"}
                  </button>
                )}

                <button
                  type="button"
                  className="proto-library-btn"
                  onClick={handleCopyDirectRef}
                  title="Copy a stable @smartnote URI — paste into Claude / Cursor prompts to reference this exact document"
                >
                  <Copy size={11} strokeWidth={2} />
                  {copiedRef ? "Copied" : "Copy direct-ref"}
                </button>

                {/* Re-classify dropdown */}
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
            <div className={cn(
              "proto-library-content-scroll",
              viewMode === "raw" && "proto-library-content-scroll-raw",
            )}>
              {viewMode === "raw" ? (
                rawContent === null ? (
                  <div style={{ padding: 24, fontSize: 12, color: "var(--color-text-muted)" }}>
                    loading content…
                  </div>
                ) : (
                  <pre className="proto-library-raw">{rawContent}</pre>
                )
              ) : (
                <div className="proto-library-card-list">
                  {/* Pipeline status — clickable summary of KP pass state */}
                  <div className="proto-doc-card">
                    <div className="proto-doc-card-head">
                      <div className="proto-doc-card-title">Pipeline status</div>
                      <div className="proto-doc-card-meta">{active.id.slice(0, 8)}</div>
                    </div>
                    <div className="proto-doc-card-snippet">
                      Created {fmtDate(active.created_at)}
                      {active.updated_at && ` · updated ${fmtDate(active.updated_at)}`}
                      {active.ingested_at
                        ? ` · ingested ${fmtDate(active.ingested_at)}`
                        : " · not yet ingested — run Embedding from KP"}
                    </div>
                    <div className="proto-doc-card-tags">
                      <span className={cn("proto-tag", active.ingested_at && "proto-tag-accent")}>
                        E: {active.ingested_at ? "embedded" : "pending"}
                      </span>
                      <span className="proto-tag">
                        N: {(active.metadata as Record<string, unknown> | null)?.["enrich_status"] === "done" ? "enriched" : "pending"}
                      </span>
                      <span className="proto-tag">
                        T: {Array.isArray((active.metadata as Record<string, unknown> | null)?.["ai_tags"])
                          ? "tagged"
                          : "pending"}
                      </span>
                    </div>
                  </div>

                  {/* Document metadata snapshot */}
                  {active.metadata && Object.keys(active.metadata).length > 0 && (
                    <div className="proto-doc-card">
                      <div className="proto-doc-card-head">
                        <div className="proto-doc-card-title">Metadata</div>
                      </div>
                      <div className="proto-doc-card-tags">
                        {Object.entries(active.metadata)
                          .filter(([, v]) => typeof v !== "object")
                          .slice(0, 12)
                          .map(([k, v]) => (
                            <span key={k} className="proto-tag" title={`${k}: ${String(v)}`}>
                              {k}: {String(v).slice(0, 40)}
                            </span>
                          ))}
                      </div>
                    </div>
                  )}

                  {/* Smartsheet preview placeholder for wiki kind */}
                  {kindOf(active) === "wiki_topic" && (
                    <div className="proto-doc-card" style={{ borderStyle: "dashed" }}>
                      <div className="proto-doc-card-head">
                        <div className="proto-doc-card-title">Wiki smartsheet</div>
                        <div className="proto-doc-card-meta">chapter × concept matrix</div>
                      </div>
                      <div className="proto-doc-card-snippet" style={{ color: "var(--color-text-muted)" }}>
                        Click <em>Build wiki-smartsheet</em> above to extract per-chapter
                        entities, key claims, open questions, and references. The result
                        renders here as a structured table.
                      </div>
                    </div>
                  )}

                  {/* Chunks list placeholder — backend endpoint
                      /v1/documents/{id}/chunks lands alongside this commit */}
                  <div className="proto-doc-card" style={{ borderStyle: "dashed" }}>
                    <div className="proto-doc-card-head">
                      <div className="proto-doc-card-title">Chunks</div>
                      <div className="proto-doc-card-meta">{active.ingested_at ? "indexed" : "—"}</div>
                    </div>
                    <div className="proto-doc-card-snippet" style={{ color: "var(--color-text-muted)" }}>
                      Per-chunk listing (text · dimension · keywords · scores) coming
                      with the cloud /v1/documents/{`{id}`}/chunks endpoint.
                      For now: search this doc via Stream's ⌘K to see chunks via 6-path retrieval.
                    </div>
                  </div>
                </div>
              )}
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
