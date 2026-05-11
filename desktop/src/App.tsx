import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence } from "framer-motion";
import { AtelierShell } from "./components/atelier/AtelierShell";
import { StreamHome } from "./components/atelier/StreamHome";
import { LibraryShell } from "./components/library/LibraryShell";
import { NihoParticles } from "./components/layout/NihoParticles";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { Toast } from "./components/layout/Toast";
import { NoteWorkspace } from "./components/note/NoteWorkspace";
import { WikiSourceViewer } from "./components/wiki/WikiSourceViewer";
import { usePrefs } from "./hooks/usePrefs";
import { useTags } from "./hooks/useTags";
import { useTheme } from "./hooks/useTheme";
import * as cloudApi from "./lib/cloud-api";
import { onIngestStatus, onWikiIngestStatus, getIngestStatus, onWsEvent } from "./lib/electron";
import type { IngestEvent } from "./lib/electron";
import type { ChannelId } from "./lib/types";

/* App — v3 stream-centric router.
 *
 * Closed channel union (lib/types.ts): stream | note | library:docs |
 * library:memories | library:skills | settings | source:<path>.
 * Cloud is a modal overlay, not a channel.
 */

export type IngestStep = {
  key: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail: string;
  current: number;
  total: number;
  elapsedMs: number;
  actor?: string;
  kind?: string;
};

const STEP_LABELS: Record<string, string> = {
  parse: "Parsing raw file",
  embed: "Generating embeddings",
  segment: "Chinese text segmentation",
  ai_enrich: "AI enrichment",
  store: "Storing chunks & views",
  views: "Generating views",
};
const STEP_ORDER = ["parse", "embed", "segment", "ai_enrich", "store", "views"];

const WIKI_STEP_LABELS: Record<string, string> = {
  fetch: "Fetching document",
  rewrite: "AI formatting to Markdown",
  parse: "Scanning files",
  embed: "Generating embeddings",
  segment: "Text segmentation",
  ai_enrich: "AI enrichment",
  store: "Storing chunks",
};
const WIKI_STEP_ORDER = ["fetch", "rewrite", "parse", "embed", "segment", "ai_enrich", "store"];

function initialSteps(): IngestStep[] {
  return STEP_ORDER.map((key) => ({
    key,
    label: STEP_LABELS[key] || key,
    status: "pending" as const,
    detail: "",
    current: 0,
    total: 0,
    elapsedMs: 0,
  }));
}

function initialWikiSteps(): IngestStep[] {
  return WIKI_STEP_ORDER.map((key) => ({
    key,
    label: WIKI_STEP_LABELS[key] || key,
    status: "pending" as const,
    detail: "",
    current: 0,
    total: 0,
    elapsedMs: 0,
  }));
}

const PROPOSAL_POLL_MS = 30_000;

export default function App() {
  const [activeChannel, setActiveChannel] = useState<ChannelId>("stream");
  const [toast, setToast] = useState<{ message: string; type: "info" | "success" | "error" } | null>(null);
  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestSteps, setIngestSteps] = useState<IngestStep[]>([]);
  const [ingestResult, setIngestResult] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [buildVersion, setBuildVersion] = useState(0);

  const [wikiIngestBusy, setWikiIngestBusy] = useState(false);
  const [wikiIngestSteps, setWikiIngestSteps] = useState<IngestStep[]>([]);
  const [wikiIngestResult, setWikiIngestResult] = useState<{ message: string; type: "success" | "error" } | null>(null);

  // Pending-memory count drives the rail badge + Library tab "pending" accent.
  const [pendingMemoryCount, setPendingMemoryCount] = useState(0);

  const prefs = usePrefs();
  const { tags, refreshTags } = useTags();
  const { mode: themeMode } = useTheme();
  const activeChannelRef = useRef(activeChannel);
  activeChannelRef.current = activeChannel;

  useEffect(() => {
    refreshTags();
  }, [refreshTags]);

  // ⌘K Spotlight is its own frameless BrowserWindow (see
  // electron/main.mjs ensureSpotlightWindow). When the user picks a
  // result there, main forwards "smartnote:open-source" with the
  // channel id and brings the main window forward — react by
  // switching to that channel here.
  useEffect(() => {
    const off = window.desktop?.onOpenSource?.((data) => {
      if (data?.channel) setActiveChannel(data.channel as ChannelId);
    });
    return () => { off?.(); };
  }, []);

  // Listen for tag-vocabulary changes from anywhere in the app —
  // Library WorkspacePanel's tag CRUD (add / rename / delete)
  // dispatches this so the Note top-strip updates without an app
  // restart. Avoids threading callbacks through every intermediate
  // component.
  useEffect(() => {
    const handler = () => refreshTags();
    window.addEventListener("smartnote:tags-changed", handler);
    return () => window.removeEventListener("smartnote:tags-changed", handler);
  }, [refreshTags]);

  // Poll pending memory proposals every 30s. Errors are silent — the
  // rail badge is decorative, not critical, so a momentary cloud blip
  // shouldn't error-flash the UI.
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) setPendingMemoryCount(0);
          return;
        }
        const res = await cloudApi.listProposals(50);
        if (alive) setPendingMemoryCount(res.proposals.length);
      } catch {
        /* silent */
      }
    }
    load();
    const id = setInterval(load, PROPOSAL_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    const unlisten = onIngestStatus((event: IngestEvent) => {
      if (event.status === "started") {
        setIngestBusy(true);
        setIngestResult(null);
        setIngestSteps(initialSteps());
        setToast({ message: event.message, type: "info" });
      } else if (event.status === "progress") {
        setIngestSteps((prev) => prev.map((s) => {
          if (s.key === event.step) return { ...s, status: "active", detail: event.message, current: event.current, total: event.total, elapsedMs: event.elapsed_ms, actor: event.actor, kind: event.kind };
          const thisIdx = STEP_ORDER.indexOf(s.key);
          const eventIdx = STEP_ORDER.indexOf(event.step);
          if (thisIdx < eventIdx && s.status !== "done") return { ...s, status: "done" };
          return s;
        }));
        if (event.actor === "mcp:delegate") setIngestBusy(true);
      } else if (event.status === "completed") {
        setIngestBusy(false);
        setIngestSteps((prev) => prev.map((s) => ({ ...s, status: "done" })));
        setIngestResult({ message: event.message, type: "success" });
        setToast({ message: event.message, type: "success" });
        setBuildVersion((v) => v + 1);
      } else if (event.status === "error") {
        setIngestBusy(false);
        setIngestResult({ message: event.message, type: "error" });
        setToast({ message: event.message, type: "error" });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const unlisten = onWikiIngestStatus((event: IngestEvent) => {
      if (event.status === "started") {
        setWikiIngestBusy(true);
        setWikiIngestResult(null);
        setWikiIngestSteps(initialWikiSteps());
      } else if (event.status === "progress") {
        setWikiIngestSteps((prev) => prev.map((s) => {
          if (s.key === event.step) return { ...s, status: "active", detail: event.message, current: event.current, total: event.total, elapsedMs: event.elapsed_ms, actor: event.actor, kind: event.kind };
          const thisIdx = WIKI_STEP_ORDER.indexOf(s.key);
          const eventIdx = WIKI_STEP_ORDER.indexOf(event.step);
          if (thisIdx < eventIdx && s.status !== "done") return { ...s, status: "done" };
          return s;
        }));
        if (event.actor === "mcp:delegate") setWikiIngestBusy(true);
      } else if (event.status === "completed") {
        setWikiIngestBusy(false);
        setWikiIngestSteps((prev) => prev.map((s) => ({ ...s, status: "done" })));
        setWikiIngestResult({ message: event.message, type: "success" });
        setToast({ message: event.message, type: "success" });
        setBuildVersion((v) => v + 1);
      } else if (event.status === "error") {
        setWikiIngestBusy(false);
        setWikiIngestResult({ message: event.message, type: "error" });
        setToast({ message: event.message, type: "error" });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    getIngestStatus().then(({ noteIngestRunning: note, wikiIngestRunning: wiki }) => {
      if (note) {
        setIngestBusy(true);
        setIngestSteps(initialSteps().map((s) => ({ ...s, status: "active", detail: "Recovering..." })));
      }
      if (wiki) {
        setWikiIngestBusy(true);
        setWikiIngestSteps(initialWikiSteps().map((s) => ({ ...s, status: "active", detail: "Recovering..." })));
      }
    }).catch(() => {});
  }, []);

  // Cloud-pushed events → toast + refresh.
  //
  // The unified envelope is `processing_done` (per integration doc
  // §3.1 + §10.2). Legacy `enrich_done` is kept here for the cloud
  // migration window and removed once cloud stops emitting it. Both
  // funnel into the same handler so behavior is consistent.
  useEffect(() => {
    const off = onWsEvent((e) => {
      if (e.type === "processing_done") {
        const ev = e as {
          document_id?: string; document_name?: string;
          stage?: string; kind?: string; status?: string;
          message?: string; progress?: { total?: number };
          data?: { segments_count?: number; tokens_total?: number };
        };
        // Don't toast for routine background topology runs — they're
        // fast + happen as bulk auto-tail and would spam.
        if ((ev.kind || ev.stage) === "graph_topology") return;
        const stage = (ev.kind || ev.stage || "Processing").replace(/_/g, " ");
        const docName = ev.document_name || "a document";
        const data = ev.data || {};
        const segs = typeof data.segments_count === "number" ? data.segments_count : null;
        const tokens = typeof data.tokens_total === "number" ? data.tokens_total : null;
        const tail = [
          segs !== null ? `${segs} segments` : null,
          tokens ? `${tokens.toLocaleString()} tokens` : null,
        ].filter(Boolean).join(" · ");
        setToast({
          message: ev.status === "failed"
            ? `${stage} failed for ${docName}${ev.message ? ` — ${ev.message}` : ""}`
            : `${stage} done · ${docName}${tail ? ` · ${tail}` : ""}`,
          type: ev.status === "failed" ? "error" : "success",
        });
        setBuildVersion((v) => v + 1);
        // Bridge into the DOM event so useDocPipelineStates (Library
        // tree chips) and any other listeners refresh within ms
        // instead of waiting for the 6s background poll. Without
        // this, the chip stays grey/"running" until the next tick
        // even though processing_done has already landed.
        try { window.dispatchEvent(new CustomEvent("smartnote:doc-pipeline-changed")); } catch { /* silent */ }
        // Tag vocabulary may have grown during chunk_enrich /
        // note_classify; refresh once for either kind.
        if ((ev.kind || ev.stage) === "chunk_enrich" || (ev.kind || ev.stage) === "note_classify") {
          refreshTags();
        }
        return;
      }
      // Legacy event — covered by processing_done above for new
      // cloud builds. Kept for backwards compat during rollout.
      if (e.type === "enrich_done") {
        const ev = e as { document_name?: string; segments_count?: number; tokens_total?: number };
        const docName = ev.document_name || "a document";
        const tokens = ev.tokens_total ? ` · ${(ev.tokens_total).toLocaleString()} tokens` : "";
        setToast({
          message: `Enriched ${docName} — ${ev.segments_count || 0} segments${tokens}`,
          type: "success",
        });
        setBuildVersion((v) => v + 1);
        refreshTags();
        return;
      }
      if (e.type === "memory_proposed") {
        const ev = e as { agent?: string; kind?: string; preview?: string };
        setToast({
          message: `${ev.agent || "Agent"} proposed a ${ev.kind || "memory"}: "${(ev.preview || "").slice(0, 80)}…"`,
          type: "info",
        });
      }
      // WS link recovered (initial connect or after a zombie-socket
      // reconnect). Bridge to the DOM event so hooks like
      // useDocPipelineStates can refetch state that may have drifted
      // while we were silently disconnected.
      if (e.type === "ws_recovered") {
        try { window.dispatchEvent(new CustomEvent("smartnote:ws-recovered")); } catch { /* silent */ }
      }
    });
    return off;
  }, []);

  const handleIngestComplete = useCallback(() => {
    refreshTags();
    setBuildVersion((v) => v + 1);
  }, [refreshTags]);

  function renderMainPanel(ctx?: { openPalette: () => void; openCloud: () => void }) {
    if (activeChannel === "stream") {
      return <StreamHome onSelect={setActiveChannel} onOpenPalette={ctx?.openPalette} />;
    }
    if (activeChannel === "settings") return <SettingsPanel />;
    if (activeChannel === "note") {
      return (
        <NoteWorkspace
          rawPath={prefs.rawPath}
          notePath={prefs.notePath}
          onSetRawPath={prefs.setRawPath}
          onSetNotePath={prefs.setNotePath}
          onIngestComplete={handleIngestComplete}
          ingestBusy={ingestBusy}
          ingestSteps={ingestSteps}
          ingestResult={ingestResult}
          buildVersion={buildVersion}
          tags={tags}
          onTagsChanged={refreshTags}
        />
      );
    }
    if (activeChannel === "library:docs"
        || activeChannel === "library:memories"
        || activeChannel === "library:skills") {
      const sub = activeChannel.slice("library:".length) as "docs" | "memories" | "skills";
      return (
        <LibraryShell
          active={sub}
          onSelect={setActiveChannel}
          pendingMemoryCount={pendingMemoryCount}
        />
      );
    }
    if (activeChannel.startsWith("source:")) {
      // Channel format: source:<id-or-path>[#L<start>-<end>]
      // Optional line-range hash drives the viewer's auto-scroll
      // + highlight when the user clicks a chunk in Stream.
      const rest = activeChannel.slice("source:".length);
      const m = rest.match(/^([^#]+)(?:#L(\d+)-(\d+))?$/);
      const filePath = m ? m[1] : rest;
      const lineStart = m && m[2] ? parseInt(m[2], 10) : undefined;
      const lineEnd = m && m[3] ? parseInt(m[3], 10) : undefined;
      return <WikiSourceViewer filePath={filePath} lineStart={lineStart} lineEnd={lineEnd} />;
    }
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-[13px]">
        Select a page
      </div>
    );
  }

  // Quiet warning so wiki ingest progress doesn't get TS-flagged as
  // unused; downstream Library Docs pane in Phase 3 will consume them.
  void wikiIngestBusy;
  void wikiIngestSteps;
  void wikiIngestResult;

  return (
    <>
      {themeMode === "niho" && <NihoParticles />}
      <AtelierShell
        activeChannel={activeChannel}
        onSelect={setActiveChannel}
        ingestBusy={ingestBusy}
        pendingMemoryCount={pendingMemoryCount}
      >
        {(ctx) => renderMainPanel(ctx)}
      </AtelierShell>
      <AnimatePresence>
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </AnimatePresence>
      {/* Spotlight lives in its own frameless BrowserWindow now —
          opens via global ⌘K, NOT inside the main canvas. */}
    </>
  );
}
