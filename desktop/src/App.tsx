import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence } from "framer-motion";
import { AtelierShell } from "./components/atelier/AtelierShell";
import { StreamHome } from "./components/atelier/StreamHome";
import { LibraryShell } from "./components/library/LibraryShell";
import { RAGPage } from "./components/rag/RAGPage";
import { NihoParticles } from "./components/layout/NihoParticles";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { Toast } from "./components/layout/Toast";
import { NotePage } from "./components/note/NotePage";
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
  // RAGPage's tag CRUD (add / rename / delete) dispatches this so
  // the Note top-strip updates without an app restart. Avoids
  // threading callbacks through every intermediate component.
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

  // Cloud-pushed events (enrich_done / memory_proposed) → toast.
  // Closes "wiki_enrich 完成了用户没感知" feedback. agent_active is
  // handled by useAgentActivity → BottomBar; we DON'T toast that one
  // (would spam every time an agent calls a tool).
  useEffect(() => {
    const off = onWsEvent((e) => {
      if (e.type === "enrich_done") {
        const ev = e as { document_name?: string; segments_count?: number; tokens_total?: number };
        const docName = ev.document_name || "a document";
        const tokens = ev.tokens_total ? ` · ${(ev.tokens_total).toLocaleString()} tokens` : "";
        setToast({
          message: `Enriched ${docName} — ${ev.segments_count || 0} segments${tokens}`,
          type: "success",
        });
        // Trigger Library / RAG re-fetch via build version bump.
        setBuildVersion((v) => v + 1);
        // Workspace tag vocabulary may have grown during enrichment
        // (classifier auto-creates tags). Re-pull so the Note top
        // strip and other tag chips reflect the new vocabulary
        // without an app restart.
        refreshTags();
        const docId = (e as { document_id?: string }).document_id;
        if (docId) {
          window.dispatchEvent(new CustomEvent("smartnote:doc-pipeline-changed", {
            detail: { document_id: docId, kind: "ai_enrich" },
          }));
        }
      } else if (e.type === "wiki_abstract_done") {
        const ev = e as { document_id?: string; chapters?: number; summarized?: number; failed?: number };
        const docId = ev.document_id || "";
        const failed = ev.failed || 0;
        setToast({
          message: failed > 0
            ? `Wiki abstract: ${ev.summarized || 0}/${ev.chapters || 0} chapters · ${failed} failed`
            : `Wiki abstract built — ${ev.summarized || 0}/${ev.chapters || 0} chapters`,
          type: failed > 0 ? "info" : "success",
        });
        setBuildVersion((v) => v + 1);
        if (docId) {
          window.dispatchEvent(new CustomEvent("smartnote:doc-pipeline-changed", {
            detail: { document_id: docId, kind: "wiki_abstract" },
          }));
        }
      } else if (e.type === "chunk_embed_done") {
        const ev = e as { document_id?: string; smartnote_type?: string };
        setBuildVersion((v) => v + 1);
        if (ev.document_id) {
          window.dispatchEvent(new CustomEvent("smartnote:doc-pipeline-changed", {
            detail: { document_id: ev.document_id, kind: "chunk_embed" },
          }));
        }
      } else if (e.type === "ai_enrich_queued") {
        const ev = e as { document_id?: string };
        if (ev.document_id) {
          window.dispatchEvent(new CustomEvent("smartnote:doc-pipeline-changed", {
            detail: { document_id: ev.document_id, kind: "ai_enrich_queued" },
          }));
        }
      } else if (e.type === "memory_proposed") {
        const ev = e as { agent?: string; kind?: string; preview?: string };
        setToast({
          message: `${ev.agent || "Agent"} proposed a ${ev.kind || "memory"}: "${(ev.preview || "").slice(0, 80)}…"`,
          type: "info",
        });
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
        <NotePage
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
    if (activeChannel === "rag") {
      return <RAGPage />;
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
