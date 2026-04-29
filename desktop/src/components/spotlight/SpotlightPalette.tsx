import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, FileUp, ArrowDownToLine, FileText, BookOpen, File } from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { appendTextToRaw } from "@/lib/electron";
import { cn } from "@/lib/cn";

/* Spotlight palette — global ⌘K command surface.
 *
 *   ┌─────────────────────────────────────────────────┐
 *   │  🔍 Ask, search, or paste a thought…       Esc  │
 *   ├─────────────────────────────────────────────────┤
 *   │  RESULTS (live, debounced 250ms)                │
 *   │  📝 note name        L12-18  · note · 0.84      │
 *   │  📚 wiki name        L1-30   · wiki · 0.79      │
 *   │  📄 doc name         L0-12   · doc  · 0.72      │
 *   ├─────────────────────────────────────────────────┤
 *   │  [↑ Append to note]   [⤴ Upload .md to wiki]    │
 *   └─────────────────────────────────────────────────┘
 *
 * Design notes:
 *   - Translucent glass via backdrop-filter (Safari + WebKit; Electron
 *     uses Chromium ≥ 90 which fully supports it).
 *   - Mounted at the App root, not inside a panel — Spotlight should
 *     occlude everything else.
 *   - 'Append to note' takes the current input text + appends to the
 *     active raw note (rawPath comes from prefs).
 *   - 'Upload .md to wiki' opens a file picker, uploads each pick as
 *     a wiki_topic CloudDocument (same flow as Library → Import).
 */

type Kind = "note" | "wiki" | "doc";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Active raw file path — needed for the "Append to note" action. */
  rawPath: string | null;
  /** Click on a result row → request parent navigate to that source. */
  onPickSource?: (channel: string) => void;
  /** When true, the palette IS the entire window (no full-screen
   *  backdrop fill, no centered modal layout — the panel fills
   *  the transparent BrowserWindow itself). */
  windowMode?: boolean;
};

const DEBOUNCE_MS = 220;

export function SpotlightPalette({ open, onClose, rawPath, onPickSource, windowMode }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<cloudApi.ChunkSearchHit[]>([]);
  const [docKinds, setDocKinds] = useState<Map<string, Kind>>(new Map());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"" | "append" | "upload">("");
  const [flash, setFlash] = useState<{ msg: string; tone: "ok" | "err" } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reset query + focus input on every open. Without the focus call
  // the user has to click the input after the hotkey, which negates
  // the whole point of a global shortcut.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setHits([]);
    setBusy("");
    setFlash(null);
    // requestAnimationFrame: input element is mounted but layout
    // hasn't settled until next frame; focus before then is a no-op.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Cache doc-id → kind so the result rows can show the right icon.
  // One cheap fetch per open; doesn't refresh while open.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    cloudApi.listDocuments()
      .then((res) => {
        if (!alive) return;
        const m = new Map<string, Kind>();
        for (const d of res.documents) {
          const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
          const snt = String(md.smartnote_type || "");
          m.set(d.id, snt === "wiki_topic" ? "wiki" : snt === "note" ? "note" : "doc");
        }
        setDocKinds(m);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [open]);

  // Debounced search. Cancels in-flight when the user keeps typing
  // so we never render stale results over fresher keystrokes.
  useEffect(() => {
    if (!open) return;
    const text = q.trim();
    if (!text) { setHits([]); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) { setHits([]); setLoading(false); }
          return;
        }
        const r = await cloudApi.searchChunks(text, { topk: 10 });
        if (!alive) return;
        setHits(r.results);
      } catch {
        if (alive) setHits([]);
      } finally {
        if (alive) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open]);

  // Esc / global ⌘K toggle. The renderer also receives a global ⌘K
  // event from main, but in-window key handling is faster + lets us
  // close cleanly. Stop bubbling so the editor below doesn't see it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const groups = useMemo(() => {
    const g: Record<Kind, cloudApi.ChunkSearchHit[]> = { note: [], wiki: [], doc: [] };
    for (const h of hits) {
      const k = docKinds.get(h.document_id) || "doc";
      g[k].push(h);
    }
    return g;
  }, [hits, docKinds]);

  if (!open) return null;

  async function handleAppend() {
    const text = q.trim();
    if (!text) {
      setFlash({ msg: "type something to append", tone: "err" });
      return;
    }
    if (!rawPath) {
      setFlash({ msg: "no active note — open a note first", tone: "err" });
      return;
    }
    setBusy("append");
    try {
      await appendTextToRaw(rawPath, text);
      setFlash({ msg: `appended to ${rawPath.split("/").pop()}`, tone: "ok" });
      setQ("");
    } catch (e) {
      setFlash({ msg: e instanceof Error ? e.message : String(e), tone: "err" });
    } finally {
      setBusy("");
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setBusy("upload");
    let ok = 0;
    for (const f of files) {
      try {
        const content = await f.text();
        await cloudApi.createDocument({
          name: f.name.replace(/\.(md|txt|markdown)$/i, ""),
          content,
          kind: "markdown",
          metadata: { smartnote_type: "wiki_topic", imported_at: new Date().toISOString() },
        });
        ok++;
      } catch { /* per-file tolerant */ }
    }
    if (fileRef.current) fileRef.current.value = "";
    setBusy("");
    setFlash({
      msg: ok === files.length
        ? `uploaded ${ok} wiki doc${ok === 1 ? "" : "s"}`
        : `uploaded ${ok}/${files.length} (${files.length - ok} failed)`,
      tone: ok === files.length ? "ok" : "err",
    });
  }

  function pickSource(hit: cloudApi.ChunkSearchHit) {
    const range = (hit.line_start && hit.line_end && hit.line_start > 0)
      ? `#L${hit.line_start}-${hit.line_end}`
      : "";
    onPickSource?.(`source:${hit.document_id}${range}`);
    onClose();
  }

  // The panel JSX is identical across modes — only the wrapper
  // differs. Inlined with a ternary so we don't define a wrapper
  // component inside this function body (doing so would re-mount
  // the entire panel on every keystroke, which triggers the open
  // animation again and feels like a flicker).
  const panel = (
    <div
      className={cn("proto-spotlight", windowMode && "proto-spotlight-window")}
      role="dialog"
      aria-label="Spotlight"
      aria-modal="true"
    >
        <div className="proto-spotlight-input-row">
          <Search size={16} strokeWidth={1.8} className="proto-spotlight-input-icon" />
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Enter on a query → just keep typing/searching. Enter on
              // an empty input → append nothing (no-op). The two action
              // buttons handle commits explicitly.
              if (e.key === "Enter" && hits.length > 0) {
                e.preventDefault();
                pickSource(hits[0]);
              }
            }}
            placeholder="Ask, search, or paste a thought…"
            className="proto-spotlight-input"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <kbd className="proto-spotlight-esc">Esc</kbd>
        </div>

        {/* Results — grouped by source kind so notes (your own) don't
            blend with wiki (broader). Empty state shows a quiet hint. */}
        <div className="proto-spotlight-results">
          {loading && q.trim() && (
            <div className="proto-spotlight-empty">searching…</div>
          )}
          {!loading && q.trim() && hits.length === 0 && (
            <div className="proto-spotlight-empty">No matches. Try a different phrasing.</div>
          )}
          {!q.trim() && (
            <div className="proto-spotlight-empty">
              Type to search across notes, wiki, and docs.
            </div>
          )}
          {([
            { k: "note" as const, label: "Notes" },
            { k: "wiki" as const, label: "Wiki" },
            { k: "doc"  as const, label: "Docs" },
          ]).map(({ k, label }) => groups[k].length > 0 && (
            <div key={k} className="proto-spotlight-group">
              <div className="proto-spotlight-group-head">{label}</div>
              {groups[k].slice(0, 5).map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className="proto-spotlight-row"
                  onClick={() => pickSource(h)}
                >
                  <KindIcon kind={k} />
                  <span className="proto-spotlight-row-text">
                    <span className="proto-spotlight-row-name">{h.document_name}</span>
                    <span className="proto-spotlight-row-snippet">
                      {h.text.slice(0, 110).replace(/\s+/g, " ")}
                    </span>
                  </span>
                  <span className="proto-spotlight-row-meta">
                    {h.line_start > 0 && <span>L{h.line_start}–{h.line_end}</span>}
                    <span className="proto-spotlight-row-score">{h.score.toFixed(2)}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Action bar — append / upload. Append uses the input text
            verbatim; upload picks .md / .txt files for wiki ingest. */}
        <div className="proto-spotlight-actions">
          <button
            type="button"
            className="proto-spotlight-action"
            onClick={handleAppend}
            disabled={busy === "append" || !q.trim() || !rawPath}
            title={rawPath
              ? `Append "${q.slice(0, 30)}…" to ${rawPath.split("/").pop()}`
              : "Open a note first to enable append"}
          >
            <ArrowDownToLine size={13} strokeWidth={2} />
            {busy === "append" ? "Appending…" : "Append to note"}
          </button>

          <input
            ref={fileRef}
            type="file"
            accept=".md,.txt,.markdown"
            multiple
            style={{ display: "none" }}
            onChange={handleUpload}
          />
          <button
            type="button"
            className="proto-spotlight-action"
            onClick={() => fileRef.current?.click()}
            disabled={busy === "upload"}
            title="Pick .md / .txt files to upload as wiki documents"
          >
            <FileUp size={13} strokeWidth={2} />
            {busy === "upload" ? "Uploading…" : "Upload to wiki"}
          </button>

          {flash && (
            <span className={cn(
              "proto-spotlight-flash",
              flash.tone === "ok" && "proto-spotlight-flash-ok",
              flash.tone === "err" && "proto-spotlight-flash-err",
            )}>
              {flash.msg}
            </span>
          )}

          <span className="proto-spotlight-spacer" />

          <button
            type="button"
            className="proto-spotlight-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>
      </div>
  );

  if (windowMode) return panel;
  return (
    <div
      className="proto-spotlight-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      {panel}
    </div>
  );
}

function KindIcon({ kind }: { kind: Kind }) {
  const Icon = kind === "note" ? FileText : kind === "wiki" ? BookOpen : File;
  return <Icon size={14} strokeWidth={1.7} className="proto-spotlight-row-icon" />;
}
