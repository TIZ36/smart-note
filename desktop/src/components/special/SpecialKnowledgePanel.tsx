import { useState, useEffect } from "react";
import { BookOpen, FolderOpen, FileText, Loader2, Plus, X, Trash2, Code, FileSearch, Archive, GitBranch, Link, Server, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { specialIngestAsync, mcpImportAsync, pickFolder, pickPdf } from "@/lib/electron";
import { WikiGraph } from "./WikiGraph";
import * as api from "@/lib/api";
import type { WikiCategory } from "@/lib/api";
import type { IngestStep } from "@/App";
import { PipelineStep } from "../shared/PipelineStep";

const CATEGORY_META: Record<WikiCategory, { label: string; icon: typeof BookOpen }> = {
  research: { label: "Research", icon: FileSearch },
  codebase: { label: "Codebase", icon: Code },
  docs: { label: "Docs", icon: BookOpen },
  reference: { label: "Reference", icon: Archive },
};

type Props = {
  ingestBusy: boolean;
  ingestSteps: IngestStep[];
  ingestResult: { message: string; type: "success" | "error" } | null;
  onTopicsChanged?: (count: number) => void;
  onSelectSource?: (filePath: string) => void;
};

type ViewTab = "topics" | "graph";

export function SpecialKnowledgePanel({ ingestBusy, ingestSteps, ingestResult, onTopicsChanged, onSelectSource }: Props) {
  const [topics, setTopics] = useState<api.SpecialKnowledgeTopic[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  const [viewTab, setViewTab] = useState<ViewTab>("topics");
  const [ingestPending, setIngestPending] = useState(0);

  useEffect(() => { loadTopics(); }, [ingestResult]);

  function loadTopics() {
    api.fetchSpecialKnowledge().then((d) => {
      setTopics(d.topics);
      setIngestPending(d.ingest_pending ?? d.topics.filter(t => t.ingested === false).length);
      onTopicsChanged?.(d.topics.length);
    }).catch(() => {});
  }

  async function handleDelete(topic: string) {
    try {
      await api.deleteSpecialKnowledge(topic);
      loadTopics();
    } catch {}
  }

  // Single-topic ingest. Reuses the same Python ingest pipeline the
  // Import dialog uses, but pre-fills the folder + topic name from
  // the row, so a synced-but-unindexed topic is one click away.
  async function handleIngestTopic(t: api.SpecialKnowledgeTopic) {
    if (ingestBusy || !t.folder) return;
    const isPdf = t.folder.toLowerCase().endsWith(".pdf");
    const isFile = isPdf || t.folder.toLowerCase().endsWith(".md") || t.folder.toLowerCase().endsWith(".markdown");
    try {
      await specialIngestAsync(
        isFile
          ? { filePath: t.folder, topicName: t.topic }
          : { folderPath: t.folder, topicName: t.topic },
      );
    } catch (e) {
      console.warn("ingest failed for", t.topic, e);
    }
  }

  // Bulk: queue every pending topic. The pipeline runs them serially
  // because a fresh build is a single global object — running in
  // parallel would step on chunks/tag_segments. We just kick off the
  // first; ingest_status events drive the UI, and when one finishes
  // we kick the next.
  async function handleIngestAllPending() {
    if (ingestBusy) return;
    const pending = topics.filter((t) => t.ingested === false);
    for (const t of pending) {
      await handleIngestTopic(t);
      // Wait for ingest to finish before queuing the next one. The
      // App-level effect updates ingestBusy when complete; we poll
      // here with a small ceiling so we never deadlock if events
      // miss.
      const start = Date.now();
      while (Date.now() - start < 10 * 60_000) {
        await new Promise((r) => setTimeout(r, 1500));
        if (!ingestBusy) break;
      }
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="proto-view-header">
        <BookOpen size={16} strokeWidth={2} />
        <span>Wiki</span>
        <span className="proto-wiki-header-count">
          {topics.length} {topics.length === 1 ? "topic" : "topics"}
        </span>
        <div className="proto-wiki-header-tabs">
          <button type="button" onClick={() => setViewTab("topics")} className={cn("proto-wiki-header-tab", viewTab === "topics" && "proto-wiki-header-tab-active")}>
            Topics
          </button>
          <button type="button" onClick={() => setViewTab("graph")} className={cn("proto-wiki-header-tab", viewTab === "graph" && "proto-wiki-header-tab-active")}>
            <GitBranch size={12} />
            Graph
          </button>
        </div>
        {/* Inline ingest status when dialog is closed */}
        {ingestBusy && !showDialog && (
          <span className="proto-wiki-header-status" onClick={() => setShowDialog(true)}>
            <Loader2 size={12} className="animate-spin" />
            Importing...
          </span>
        )}
        {ingestResult && !ingestBusy && !showDialog && (
          <span className={cn("proto-wiki-header-status", ingestResult.type === "success" ? "proto-wiki-header-status-success" : "proto-wiki-header-status-error")}>
            {ingestResult.type === "success" ? "\u2713" : "\u2717"} {ingestResult.message}
          </span>
        )}
        <div style={{ marginLeft: "auto" }}>
          <button
            type="button"
            onClick={() => setShowDialog(true)}
            className="proto-btn proto-btn-primary"
            style={{ fontSize: 12, padding: "4px 10px" }}
          >
            <Plus size={13} />
            Import
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {ingestPending > 0 && (
          <div className="proto-ingest-banner">
            <Sparkles size={14} className="proto-ingest-banner-icon" />
            <div className="proto-ingest-banner-body">
              <strong>{ingestPending}</strong>{" "}
              {ingestPending === 1 ? "topic" : "topics"} synced from cloud, not yet
              indexed. Run <em>Ingest</em> to populate keywords, summaries, and
              the knowledge graph — files are readable now; AI stays dark until
              ingest finishes.
            </div>
            <button
              type="button"
              className="proto-btn proto-btn-primary"
              onClick={handleIngestAllPending}
              disabled={ingestBusy}
              style={{ flexShrink: 0, alignSelf: "center" }}
            >
              {ingestBusy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              Ingest all
            </button>
          </div>
        )}
        {viewTab === "graph" ? (
          <WikiGraph onSelectSource={onSelectSource} />
        ) : topics.length > 0 ? (
          <div className="proto-wiki-topic-list">
            {(["research", "codebase", "docs", "reference"] as WikiCategory[])
              .filter((cat) => topics.some((t) => (t.category || "reference") === cat))
              .map((cat) => {
                const meta = CATEGORY_META[cat];
                const Icon = meta.icon;
                const catTopics = topics.filter((t) => (t.category || "reference") === cat);
                return (
                  <div key={cat}>
                    <div className="proto-wiki-category-header">
                      <Icon size={13} />
                      <span>{meta.label}</span>
                      <span className="proto-wiki-category-count">{catTopics.length}</span>
                    </div>
                    {catTopics.map((t) => (
                      <div key={t.topic} className="proto-wiki-topic-item">
                        <div className="proto-wiki-topic-body">
                          <div className="proto-wiki-topic-name">
                            {t.topic}
                            {t.ingested === false && (
                              <span className="proto-wiki-topic-pending">unindexed</span>
                            )}
                          </div>
                          {t.summary && <div className="proto-wiki-topic-summary">{t.summary}</div>}
                          <div className="proto-wiki-topic-meta">
                            <span>{t.folder}</span>
                            <span>{t.created_at ? new Date(t.created_at).toLocaleDateString() : ""}</span>
                          </div>
                        </div>
                        {t.ingested === false && (
                          <button
                            type="button"
                            onClick={() => handleIngestTopic(t)}
                            className="proto-btn proto-btn-secondary"
                            disabled={ingestBusy}
                            title={`Run ingest on ${t.folder}`}
                            style={{ fontSize: 12, padding: "4px 10px", marginRight: 6 }}
                          >
                            <Sparkles size={13} />
                            Ingest
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDelete(t.topic)}
                          className="proto-wiki-topic-delete"
                          title={`Delete ${t.topic}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })}
          </div>
        ) : (
          <div className="proto-wiki-empty">
            <BookOpen size={32} strokeWidth={1.5} className="proto-wiki-empty-icon" />
            <p className="proto-wiki-empty-title">No wiki topics yet</p>
            <p className="proto-wiki-empty-desc">
              Import reference materials — papers, docs, code — to enrich your AI search answers.
            </p>
            <button type="button" onClick={() => setShowDialog(true)} className="proto-btn proto-btn-secondary" style={{ marginTop: 16 }}>
              <Plus size={14} />
              Import your first topic
            </button>
          </div>
        )}
      </div>

      {/* Import dialog */}
      {showDialog && (
        <WikiImportDialog
          ingestBusy={ingestBusy}
          ingestSteps={ingestSteps}
          ingestResult={ingestResult}
          onClose={() => setShowDialog(false)}
        />
      )}
    </div>
  );
}

/* ── Import Dialog ── */

type ImportTab = "file" | "url" | "mcp";

function WikiImportDialog({ ingestBusy, ingestSteps, ingestResult, onClose }: {
  ingestBusy: boolean;
  ingestSteps: IngestStep[];
  ingestResult: { message: string; type: "success" | "error" } | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ImportTab>("file");
  const [topicName, setTopicName] = useState("");

  // File tab
  const [path, setPath] = useState("");

  // URL tab
  const [url, setUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlMsg, setUrlMsg] = useState("");

  // MCP tab
  const [mcpServers, setMcpServers] = useState<api.McpServer[]>([]);
  const [selectedServer, setSelectedServer] = useState("");
  const [docUrl, setDocUrl] = useState("");
  const [showAddServer, setShowAddServer] = useState(false);
  const [newServerName, setNewServerName] = useState("");
  const [newServerUrl, setNewServerUrl] = useState("");

  useEffect(() => {
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape" && !ingestBusy) onClose(); }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, ingestBusy]);

  useEffect(() => {
    if (tab === "mcp") {
      api.fetchMcpServers().then((d) => {
        setMcpServers(d.servers);
        if (d.servers.length === 1) setSelectedServer(d.servers[0].name);
      }).catch(() => {});
    }
  }, [tab]);

  // ── File ──
  async function handlePickFolder() {
    const p = await pickFolder();
    if (p) { setPath(p); if (!topicName) setTopicName(p.split("/").pop() || ""); }
  }
  async function handlePickPdf() {
    const p = await pickPdf();
    if (p) { setPath(p); if (!topicName) setTopicName(p.split("/").pop()?.replace(/\.pdf$/i, "") || ""); }
  }
  async function handleFileIngest() {
    if (!path || ingestBusy) return;
    const isPdf = path.toLowerCase().endsWith(".pdf");
    await specialIngestAsync(isPdf ? { filePath: path, topicName: topicName || undefined } : { folderPath: path, topicName: topicName || undefined });
    setPath(""); setTopicName("");
  }

  // ── URL ──
  async function handleUrlImport() {
    if (!url.trim() || urlBusy) return;
    setUrlBusy(true); setUrlMsg("");
    try {
      const r = await api.importWikiUrl(url.trim(), topicName);
      setUrlMsg(`Imported: ${(r as any).message || "done"}`);
      setUrl(""); setTopicName("");
    } catch (e) { setUrlMsg(`Failed: ${e}`); }
    setUrlBusy(false);
  }

  // ── MCP doc ──
  async function handleAddServer() {
    if (!newServerName.trim() || !newServerUrl.trim()) return;
    const d = await api.addMcpServer(newServerName.trim(), newServerUrl.trim());
    setMcpServers(d.servers);
    setSelectedServer(newServerName.trim());
    setNewServerName(""); setNewServerUrl(""); setShowAddServer(false);
  }
  async function handleDeleteServer(name: string) {
    const d = await api.deleteMcpServer(name);
    setMcpServers(d.servers);
    if (selectedServer === name) setSelectedServer("");
  }
  async function handleMcpImport() {
    if (!selectedServer || !docUrl.trim()) return;
    // Uses subprocess pipeline — progress streams through wiki ingest events
    await mcpImportAsync({
      serverName: selectedServer,
      docUrl: docUrl.trim(),
      topicName: topicName || undefined,
    });
    setDocUrl(""); setTopicName("");
  }

  const hasProgress = ingestSteps.length > 0 && ingestSteps.some(s => s.status !== "pending");
  const busy = ingestBusy || urlBusy;

  return (
    <div className="proto-dialog-overlay" onClick={() => !busy && onClose()}>
      <div className="proto-dialog" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <div className="proto-dialog-header">
          <span>Import to Wiki</span>
          <button type="button" onClick={onClose} className="proto-dialog-close"><X size={14} /></button>
        </div>

        <div className="proto-import-tabs">
          <button type="button" onClick={() => setTab("file")} className={cn("proto-import-tab", tab === "file" && "proto-import-tab-active")}>
            <FolderOpen size={13} /> File
          </button>
          <button type="button" onClick={() => setTab("url")} className={cn("proto-import-tab", tab === "url" && "proto-import-tab-active")}>
            <Link size={13} /> URL
          </button>
          <button type="button" onClick={() => setTab("mcp")} className={cn("proto-import-tab", tab === "mcp" && "proto-import-tab-active")}>
            <Server size={13} /> MCP
          </button>
        </div>

        <div className="proto-dialog-body">
          {/* ── File tab ── */}
          {tab === "file" && (
            <>
              <div className="proto-form-field">
                <label className="proto-form-label">Source</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="text" value={path} onChange={(e) => setPath(e.target.value)} placeholder="Select file or folder..." className="proto-form-input proto-form-input-mono" style={{ flex: 1, minWidth: 0 }} />
                  <button type="button" onClick={handlePickFolder} className="proto-btn proto-btn-secondary" style={{ flexShrink: 0 }}><FolderOpen size={13} /> Folder</button>
                  <button type="button" onClick={handlePickPdf} className="proto-btn proto-btn-secondary" style={{ flexShrink: 0 }}><FileText size={13} /> PDF</button>
                </div>
              </div>
              <TopicNameField value={topicName} onChange={setTopicName} onSubmit={handleFileIngest} />
              <ImportButton busy={ingestBusy} disabled={!path} onClick={handleFileIngest} label="Import" busyLabel="Importing..." />
            </>
          )}

          {/* ── URL tab ── */}
          {tab === "url" && (
            <>
              <div className="proto-form-field">
                <label className="proto-form-label">URL</label>
                <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleUrlImport()} placeholder="https://..." className="proto-form-input proto-form-input-mono" />
              </div>
              <TopicNameField value={topicName} onChange={setTopicName} onSubmit={handleUrlImport} />
              <ImportButton busy={urlBusy} disabled={!url.trim()} onClick={handleUrlImport} label="Import URL" busyLabel="Fetching..." icon={<Link size={14} />} />
              {urlMsg && <p className="proto-form-hint" style={{ marginTop: 8 }}>{urlMsg}</p>}
            </>
          )}

          {/* ── MCP tab (document-focused) ── */}
          {tab === "mcp" && (
            <>
              <div className="proto-form-field">
                <label className="proto-form-label">MCP Server</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <select value={selectedServer} onChange={(e) => setSelectedServer(e.target.value)} className="proto-form-input" style={{ flex: 1 }}>
                    <option value="">Select server...</option>
                    {mcpServers.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                  </select>
                  <button type="button" onClick={() => setShowAddServer(!showAddServer)} className="proto-btn proto-btn-secondary" style={{ flexShrink: 0 }}><Plus size={13} /></button>
                  {selectedServer && (
                    <button type="button" onClick={() => handleDeleteServer(selectedServer)} className="proto-btn proto-btn-secondary" style={{ flexShrink: 0, color: "var(--color-danger)" }}><Trash2 size={13} /></button>
                  )}
                </div>
              </div>

              {showAddServer && (
                <div style={{ background: "var(--color-bg-elevated)", padding: 12, borderRadius: "var(--radius-proto)", display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                  <input type="text" value={newServerName} onChange={(e) => setNewServerName(e.target.value)} placeholder="Name (e.g. feishu)" className="proto-form-input" />
                  <input type="text" value={newServerUrl} onChange={(e) => setNewServerUrl(e.target.value)} placeholder="MCP stream URL" className="proto-form-input proto-form-input-mono" style={{ fontSize: 11 }} />
                  <button type="button" onClick={handleAddServer} disabled={!newServerName.trim() || !newServerUrl.trim()} className="proto-btn proto-btn-primary" style={{ alignSelf: "flex-start" }}>Add</button>
                </div>
              )}

              {selectedServer && (
                <>
                  <div className="proto-form-field">
                    <label className="proto-form-label">Document URL</label>
                    <input type="text" value={docUrl} onChange={(e) => setDocUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleMcpImport()} placeholder="https://xxx.feishu.cn/wiki/..." className="proto-form-input proto-form-input-mono" />
                    <p className="proto-form-hint">Paste a Feishu/Lark document link. The document ID will be extracted automatically.</p>
                  </div>
                  <TopicNameField value={topicName} onChange={setTopicName} onSubmit={handleMcpImport} />
                  <ImportButton busy={ingestBusy} disabled={!docUrl.trim()} onClick={handleMcpImport} label="Import Document" busyLabel="Importing..." icon={<Server size={14} />} />
                </>
              )}
            </>
          )}

          {/* Pipeline progress (file import) */}
          {hasProgress && (
            <div className="proto-pipeline" style={{ marginTop: 16 }}>
              <div className="proto-pipeline-header" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span>Pipeline</span>
                {ingestBusy && <Loader2 size={12} className="animate-spin text-[var(--color-accent)] ml-auto" />}
                {!ingestBusy && ingestResult && (
                  <span className={cn("ml-auto text-[11px] font-medium", ingestResult.type === "success" ? "text-[var(--color-success)]" : "text-[var(--color-danger)]")}>
                    {ingestResult.type === "success" ? "Done" : "Failed"}
                  </span>
                )}
              </div>
              {ingestSteps.map((step) => (
                <PipelineStep key={step.key} step={step} />
              ))}
            </div>
          )}

          {ingestResult && (
            <div className={cn("proto-wiki-result", ingestResult.type === "success" ? "proto-wiki-result-success" : "proto-wiki-result-error")} style={{ padding: "8px 12px", borderRadius: "var(--radius-proto)", border: "1px solid var(--color-border)", fontSize: 13, marginTop: 12 }}>
              {ingestResult.type === "success" ? "\u2713" : "\u2717"} {ingestResult.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TopicNameField({ value, onChange, onSubmit }: { value: string; onChange: (v: string) => void; onSubmit: () => void }) {
  return (
    <div className="proto-form-field">
      <label className="proto-form-label">Topic name (optional)</label>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onSubmit()} placeholder="Auto-detected from content" className="proto-form-input" />
    </div>
  );
}

function ImportButton({ busy, disabled, onClick, label, busyLabel, icon }: { busy: boolean; disabled: boolean; onClick: () => void; label: string; busyLabel: string; icon?: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={busy || disabled} className="proto-btn proto-btn-primary" style={{ width: "100%", justifyContent: "center" }}>
      {busy ? <Loader2 size={14} className="animate-spin" /> : icon || <Plus size={14} />}
      {busy ? busyLabel : label}
    </button>
  );
}
