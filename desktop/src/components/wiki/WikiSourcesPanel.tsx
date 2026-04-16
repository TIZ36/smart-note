import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, RefreshCw, FileText } from "lucide-react";
import { cn } from "@/lib/cn";
import * as api from "@/lib/api";

/**
 * Source panel — lists every wiki document grouped by its immediate parent
 * folder under `sn/source/`. Each group header is collapsible.
 *
 * Design choices (Linear/Notion quiet hierarchy):
 * - No icons on file rows; group header carries the whole visual weight.
 * - Expand state persisted to localStorage so reloads survive.
 * - Alphabetical sort on groups AND files — stable scanning.
 */

const STORAGE_KEY = "wiki-sources-collapsed";

type Props = {
  onSelectSource: (absolutePath: string) => void;
};

type Group = {
  name: string;     // "" for root-level orphans
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

function groupByFolder(sources: api.WikiSource[], baseDir: string): Group[] {
  const buckets: Record<string, api.WikiSource[]> = {};
  const rootFiles: api.WikiSource[] = [];

  for (const s of sources) {
    const rel = s.rel_path ?? stripBase(s.path, baseDir);
    const segs = rel.split("/").filter(Boolean);
    if (segs.length <= 1) {
      rootFiles.push(s);
    } else {
      (buckets[segs[0]] ||= []).push(s);
    }
  }

  const cmp = (a: api.WikiSource, b: api.WikiSource) => a.name.localeCompare(b.name);
  const folderGroups = Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, files]) => ({ name, files: files.sort(cmp) }));

  // Root files go into an unnamed group shown at the top, if any.
  const result: Group[] = [];
  if (rootFiles.length > 0) result.push({ name: "", files: rootFiles.sort(cmp) });
  result.push(...folderGroups);
  return result;
}

function stripBase(path: string, baseDir: string): string {
  if (!baseDir) return path;
  const b = baseDir.endsWith("/") ? baseDir : baseDir + "/";
  return path.startsWith(b) ? path.slice(b.length) : path;
}

export function WikiSourcesPanel({ onSelectSource }: Props) {
  const [sources, setSources] = useState<api.WikiSource[]>([]);
  const [baseDir, setBaseDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.fetchWikiSources()
      .then((d) => {
        setSources(d.sources);
        setBaseDir(d.base_dir || "");
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { saveCollapsed(collapsed); }, [collapsed]);

  const groups = useMemo(() => groupByFolder(sources, baseDir), [sources, baseDir]);

  const toggle = useCallback((name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
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
          <strong>{totalFiles}</strong> {totalFiles === 1 ? "document" : "documents"}
          <span className="proto-dashboard-lead-sep">·</span>
          <strong>{groups.filter((g) => g.name !== "").length}</strong>{" "}
          {groups.filter((g) => g.name !== "").length === 1 ? "category" : "categories"}
        </p>
      )}

      {error && <p className="proto-dashboard-error">Failed to load: {error}</p>}

      {!loading && sources.length === 0 && !error && (
        <p className="proto-dashboard-empty">
          No wiki documents yet. Import one from the Topics panel.
        </p>
      )}

      <div className="proto-source-groups">
        {groups.map((g) => {
          const isCollapsed = g.name !== "" && collapsed.has(g.name);
          return (
            <section key={g.name || "__root__"} className="proto-source-group">
              {g.name !== "" && (
                <button
                  type="button"
                  onClick={() => toggle(g.name)}
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
                  <span className="proto-source-group-name">{g.name}</span>
                  <span className="proto-source-group-count">{g.files.length}</span>
                </button>
              )}
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
