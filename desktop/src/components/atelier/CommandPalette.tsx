import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, BookOpen, MessageSquare, Search, Layers, Settings } from "lucide-react";
import * as api from "@/lib/api";
import * as cloudApi from "@/lib/cloud-api";
import type { ChannelId } from "@/lib/types";
import { cn } from "@/lib/cn";

/* ⌘K command palette — B-direction "library-tree-aware search".
 *
 * Three sources merged into a single ranked list:
 *   - Notes / Wiki documents (cloudApi.listDocuments)
 *   - Memories (cloudApi.search_memory? at MVP we just listProposals
 *     for the visible drafts surface; full semantic search lands in
 *     P3 when the proposal page becomes a tab in the palette)
 *   - Built-in actions (open Settings, switch channel, jot memory)
 *
 * The palette is the *only* entry-point for search — the legacy
 * full-page Search route stays reachable for power users who want
 * persistent results, but ⌘K is the primary affordance.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  onSelect: (channel: ChannelId) => void;
};

type Item = {
  id: string;
  kind: "note" | "wiki" | "memory" | "action";
  title: string;
  snippet?: string;
  onActivate: () => void;
};

const BUILTIN_ACTIONS: Omit<Item, "onActivate">[] = [
  { id: "act:note",     kind: "action", title: "Open note editor",       snippet: "switch to your current note" },
  { id: "act:wiki",     kind: "action", title: "Open wiki home",         snippet: "topics + sources" },
  { id: "act:settings", kind: "action", title: "Open settings",          snippet: "credentials, theme, hotkeys" },
];

export function CommandPalette({ open, onClose, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [docs, setDocs] = useState<cloudApi.CloudDocument[]>([]);
  const [proposals, setProposals] = useState<cloudApi.Proposal[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch the corpus on open. Cheap enough that we don't cache —
  // each open is a fresh window into the workspace's current state.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    let alive = true;
    (async () => {
      try {
        if (!(await cloudApi.isCloudConfigured())) return;
        const [d, p] = await Promise.all([
          cloudApi.listDocuments().catch(() => ({ documents: [] as cloudApi.CloudDocument[] })),
          cloudApi.listProposals(20).catch(() => ({ proposals: [] as cloudApi.Proposal[], total: 0 })),
        ]);
        if (!alive) return;
        setDocs(d.documents);
        setProposals(p.proposals);
      } catch { /* silent — palette must never crash */ }
    })();
    return () => { alive = false; };
  }, [open]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const d of docs) {
      const md = (d.metadata && typeof d.metadata === "object"
        ? (d.metadata as Record<string, unknown>)
        : {});
      const kind: Item["kind"] = String(md.smartnote_type) === "wiki_topic" ? "wiki" : "note";
      out.push({
        id: `doc:${d.id}`,
        kind,
        title: d.name,
        snippet: kind === "wiki" ? "wiki topic" : `${(d.byte_size / 1024).toFixed(1)} KB`,
        onActivate: () => {
          // Notes go to the editor channel; wiki goes to the source
          // viewer when we have a source path, otherwise the wiki home.
          const path = String(md.raw_path || md.path || "");
          if (kind === "note") onSelect("note");
          else if (path) onSelect(`source:${path}` as ChannelId);
          else onSelect("special-knowledge");
          onClose();
        },
      });
    }

    for (const p of proposals) {
      out.push({
        id: `prop:${p.id}`,
        kind: "memory",
        title: p.content.slice(0, 80) || "Memory proposal",
        snippet: `${p.kind} · proposed by ${p.author_agent} · conf ${p.confidence.toFixed(2)}`,
        onActivate: () => {
          onSelect("cloud-sync");  // memories live in cloud console
          onClose();
        },
      });
    }

    for (const a of BUILTIN_ACTIONS) {
      out.push({
        ...a,
        onActivate: () => {
          if (a.id === "act:note") onSelect("note");
          else if (a.id === "act:wiki") onSelect("special-knowledge");
          else if (a.id === "act:settings") onSelect("settings");
          onClose();
        },
      });
    }

    if (!query.trim()) return out.slice(0, 30);
    const q = query.toLowerCase().trim();
    return out
      .map((it) => {
        const inTitle = it.title.toLowerCase().includes(q);
        const inSnip  = (it.snippet || "").toLowerCase().includes(q);
        if (!inTitle && !inSnip) return null;
        // Rank: title hit > snippet hit; prefer shorter titles (more
        // specific matches surface first).
        const score =
          (inTitle ? 100 : 0) -
          it.title.length * 0.05 +
          (inSnip ? 5 : 0);
        return [score, it] as const;
      })
      .filter((x): x is readonly [number, Item] => x !== null)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 30)
      .map(([, it]) => it);
  }, [docs, proposals, query, onSelect, onClose]);

  // Keep `active` in range whenever the result list shrinks.
  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [items.length, active]);

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[active]?.onActivate();
    }
  }

  if (!open) return null;

  // Group by kind for the Library-tree-aware section headers.
  const groups = groupByKind(items);

  return (
    <>
      <div className="proto-atelier-veil proto-atelier-veil-open" onClick={onClose} aria-hidden="true" />
      <div className="proto-atelier-cmdk" role="dialog" aria-label="Command palette">
        <div className="proto-atelier-cmdk-inputrow">
          <Search size={14} strokeWidth={2} className="proto-atelier-cmdk-leading" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={handleKey}
            placeholder="Search, ask, or jot down a memory…"
            className="proto-atelier-cmdk-input"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="proto-atelier-cmdk-results">
          {items.length === 0 ? (
            <div className="proto-atelier-cmdk-empty">
              No matches. Try a doc name, or press Enter to keep going.
            </div>
          ) : (
            groups.map(({ label, range, kind }) => (
              <section key={label} className="proto-atelier-cmdk-group">
                <div className="proto-atelier-cmdk-group-head">{label}</div>
                {items.slice(range[0], range[1]).map((it, idx) => {
                  const globalIdx = range[0] + idx;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      className={cn(
                        "proto-atelier-cmdk-item",
                        active === globalIdx && "proto-atelier-cmdk-item-active",
                      )}
                      onMouseEnter={() => setActive(globalIdx)}
                      onClick={() => it.onActivate()}
                    >
                      <KindIcon kind={kind} />
                      <span className="proto-atelier-cmdk-item-title">{it.title}</span>
                      {it.snippet && (
                        <span className="proto-atelier-cmdk-item-snippet">{it.snippet}</span>
                      )}
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>

        {/* Footer hint — replaces the trailing `esc` kbd that used
            to clutter the input row. Three persistent affordances,
            each with the same kbd shape so they read as keyboard
            shortcuts at a glance. */}
        <div className="proto-atelier-cmdk-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </>
  );
}

function KindIcon({ kind }: { kind: Item["kind"] }) {
  if (kind === "note") return <FileText size={13} strokeWidth={2} />;
  if (kind === "wiki") return <BookOpen size={13} strokeWidth={2} />;
  if (kind === "memory") return <MessageSquare size={13} strokeWidth={2} />;
  // action
  if (kind === "action") return <Layers size={13} strokeWidth={2} />;
  return <Settings size={13} strokeWidth={2} />;
}

function groupByKind(items: Item[]): { label: string; range: [number, number]; kind: Item["kind"] }[] {
  if (items.length === 0) return [];
  const groups: { label: string; range: [number, number]; kind: Item["kind"] }[] = [];
  let start = 0;
  let prev = items[0].kind;
  for (let i = 1; i <= items.length; i++) {
    const cur = items[i]?.kind;
    if (cur !== prev) {
      groups.push({ label: kindLabel(prev), range: [start, i], kind: prev });
      if (i < items.length) {
        start = i;
        prev = cur!;
      }
    }
  }
  return groups;
}

function kindLabel(k: Item["kind"]): string {
  if (k === "note") return "Notes";
  if (k === "wiki") return "Wiki";
  if (k === "memory") return "Memories";
  return "Actions";
}
