import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  RefreshCw,
  FileText,
  BookOpen,
  FileSearch,
  Code,
  Archive,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/cn";
import * as api from "@/lib/api";
import type { WikiCategory } from "@/lib/api";

/**
 * Source panel — lists every wiki document grouped by its real
 * WikiCategory (research / codebase / docs / reference). Filesystem
 * folder layout is not used for grouping: the server-stored category
 * from tag_segments drives the hierarchy so the UI matches what the
 * Wiki page shows.
 */

const STORAGE_KEY = "wiki-sources-collapsed-cat";

const CATEGORY_META: Record<
  WikiCategory,
  { label: string; icon: typeof BookOpen }
> = {
  research: { label: "Research", icon: FileSearch },
  codebase: { label: "Codebase", icon: Code },
  docs: { label: "Docs", icon: BookOpen },
  reference: { label: "Reference", icon: Archive },
};
const CATEGORY_ORDER: WikiCategory[] = ["research", "codebase", "docs", "reference"];

type Props = {
  onSelectSource: (absolutePath: string) => void;
};

type Group = {
  key: WikiCategory;
  label: string;
  icon: typeof BookOpen;
  files: api.WikiSource[];
};

function loadCollapsed(): Set<string> {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return new Set();
    return new Set(JSON.parse(v) as string[]);
  } catch {
    return new Set();
  }
}

function saveCollapsed(s: Set<string>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}

function stripExt(name: string): string {
  return name.replace(/\.(md|txt|markdown)$/i, "");
}

function groupByCategory(sources: api.WikiSource[]): Group[] {
  const buckets: Partial<Record<WikiCategory, api.WikiSource[]>> = {};
  for (const s of sources) {
    const cat = (s.category || "reference") as WikiCategory;
    (buckets[cat] ||= []).push(s);
  }
  const cmp = (a: api.WikiSource, b: api.WikiSource) => a.name.localeCompare(b.name);
  return CATEGORY_ORDER
    .filter((k) => (buckets[k]?.length ?? 0) > 0)
    .map((k) => ({
      key: k,
      label: CATEGORY_META[k].label,
      icon: CATEGORY_META[k].icon,
      files: [...(buckets[k] as api.WikiSource[])].sort(cmp),
    }));
}

export function WikiSourcesPanel({ onSelectSource }: Props) {
  const [sources, setSources] = useState<api.WikiSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());
  const [ingestPending, setIngestPending] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.fetchWikiSources()
      .then((d) => {
        setSources(d.sources);
        setIngestPending(d.ingest_pending ?? d.sources.filter(s => s.ingested === false).length);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { saveCollapsed(collapsed); }, [collapsed]);

  const groups = useMemo(() => groupByCategory(sources), [sources]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const totalFiles = sources.length;

  return (
    <div className="proto-dashboard">
      <div className="proto-dashboard-header">
        <h1 className="proto-dashboard-title">Source</h1>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="proto-btn proto-btn-secondary"
          aria-label="Refresh sources"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
          <span>Refresh</span>
        </button>
      </div>

      {totalFiles > 0 && (
        <p className="proto-dashboard-lead">
          <strong>SN</strong>
          <span className="proto-dashboard-lead-sep">·</span>
          <strong>{totalFiles}</strong> {totalFiles === 1 ? "document" : "documents"}
          <span className="proto-dashboard-lead-sep">·</span>
          <strong>{groups.length}</strong>{" "}
          {groups.length === 1 ? "category" : "categories"}
        </p>
      )}

      {error && <p className="proto-dashboard-error">Failed to load: {error}</p>}

      {ingestPending > 0 && (
        <div className="proto-ingest-banner">
          <Sparkles size={14} className="proto-ingest-banner-icon" />
          <div className="proto-ingest-banner-body">
            <strong>{ingestPending}</strong>{" "}
            {ingestPending === 1 ? "file" : "files"} synced from cloud, not yet indexed.
            Open one and click <em>Ingest</em> to enable search, AI summaries, and
            knowledge graph for it. The file content is already readable in the meantime.
          </div>
        </div>
      )}

      {!loading && sources.length === 0 && !error && (
        <p className="proto-dashboard-empty">
          No wiki documents yet. Import one from the Topics panel.
        </p>
      )}

      <div className="proto-source-groups">
        {groups.map((g) => {
          const Icon = g.icon;
          const isCollapsed = collapsed.has(g.key);
          return (
            <section key={g.key} className="proto-source-group">
              <button
                type="button"
                onClick={() => toggle(g.key)}
                className="proto-source-group-header"
                aria-expanded={!isCollapsed}
              >
                <ChevronDown
                  size={13}
                  strokeWidth={2.2}
                  className={cn(
                    "proto-source-group-chevron",
                    isCollapsed && "proto-source-group-chevron-collapsed",
                  )}
                />
                <Icon size={13} strokeWidth={2} className="proto-source-row-icon" />
                <span className="proto-source-group-name">{g.label}</span>
                <span className="proto-source-group-count">{g.files.length}</span>
              </button>
              {!isCollapsed && (
                <ul className="proto-source-list">
                  {g.files.map((f) => (
                    <li key={f.path}>
                      <button
                        type="button"
                        onClick={() => onSelectSource(f.path)}
                        className="proto-source-row"
                        title={f.path}
                      >
                        <FileText size={12} strokeWidth={1.8} className="proto-source-row-icon" />
                        <span className="proto-source-row-name">{stripExt(f.name)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
