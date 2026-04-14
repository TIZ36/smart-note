import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence } from "framer-motion";
import { Sidebar } from "./components/layout/Sidebar";
import { SearchPage } from "./components/search/SearchPage";
import { ViewPanel } from "./components/views/ViewPanel";
import { IngestPanel } from "./components/ingest/IngestPanel";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { Toast } from "./components/layout/Toast";
import { VersionsPanel } from "./components/versions/VersionsPanel";
import { SyncRatePanel } from "./components/sync/SyncRatePanel";
import { NoteEditor } from "./components/editor/NoteEditor";
import { usePrefs } from "./hooks/usePrefs";
import { useHealth } from "./hooks/useHealth";
import { useViews } from "./hooks/useViews";
import { useSearchState } from "./hooks/useSearchState";
import { useTags } from "./hooks/useTags";
import { TagView } from "./components/tags/TagView";
import { onIngestStatus } from "./lib/electron";
import type { IngestEvent } from "./lib/electron";
import type { ChannelId } from "./lib/types";

export type IngestStep = {
  key: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail: string;
  current: number;
  total: number;
  elapsedMs: number;
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

export default function App() {
  const [activeChannel, setActiveChannel] = useState<ChannelId>("search");
  const [toast, setToast] = useState<{ message: string; type: "info" | "success" | "error" } | null>(null);
  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestSteps, setIngestSteps] = useState<IngestStep[]>([]);
  const [ingestResult, setIngestResult] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const prefs = usePrefs();
  const health = useHealth();
  const { views, refreshViews } = useViews();
  const { tags, refreshTags } = useTags();
  const searchState = useSearchState();
  const activeChannelRef = useRef(activeChannel);
  activeChannelRef.current = activeChannel;

  useEffect(() => {
    refreshTags();
    if (prefs.notePath) refreshViews(prefs.notePath);
  }, [prefs.notePath, refreshViews]);

  useEffect(() => {
    const unlisten = onIngestStatus((event: IngestEvent) => {
      if (event.status === "started") {
        setIngestBusy(true);
        setIngestResult(null);
        setIngestSteps(initialSteps());
        if (activeChannelRef.current !== "raw-input") setToast({ message: event.message, type: "info" });
      } else if (event.status === "progress") {
        setIngestSteps((prev) => prev.map((s) => {
          if (s.key === event.step) return { ...s, status: "active", detail: event.message, current: event.current, total: event.total, elapsedMs: event.elapsed_ms };
          const thisIdx = STEP_ORDER.indexOf(s.key);
          const eventIdx = STEP_ORDER.indexOf(event.step);
          if (thisIdx < eventIdx && s.status !== "done") return { ...s, status: "done" };
          return s;
        }));
      } else if (event.status === "completed") {
        setIngestBusy(false);
        setIngestSteps((prev) => prev.map((s) => ({ ...s, status: "done" })));
        setIngestResult({ message: event.message, type: "success" });
        setToast({ message: event.message, type: "success" });
        if (prefs.notePath) refreshViews(prefs.notePath);
      } else if (event.status === "error") {
        setIngestBusy(false);
        setIngestResult({ message: event.message, type: "error" });
        setToast({ message: event.message, type: "error" });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [prefs.notePath, refreshViews]);

  const handleIngestComplete = useCallback(() => {
    if (prefs.notePath) refreshViews(prefs.notePath);
    refreshTags();
  }, [prefs.notePath, refreshViews, refreshTags]);

  function renderMainPanel() {
    if (activeChannel === "settings") return <SettingsPanel />;
    if (activeChannel === "search") return <SearchPage searchState={searchState} tags={tags} />;
    if (activeChannel === "raw-input") {
      return <IngestPanel rawPath={prefs.rawPath} notePath={prefs.notePath} onSetRawPath={prefs.setRawPath} onSetNotePath={prefs.setNotePath} onIngestComplete={handleIngestComplete} ingestBusy={ingestBusy} ingestSteps={ingestSteps} ingestResult={ingestResult} />;
    }
    if (activeChannel === "editor" && prefs.rawPath) {
      return (
        <NoteEditor
          filePath={prefs.rawPath}
          onSave={async (content) => {
            try {
              const d = (window as any).desktop;
              if (d) {
                // Write file via Electron
                const fs = await d.invoke("write_file", { path: prefs.rawPath, content });
                // Trigger incremental ingest
                if (prefs.notePath) {
                  d.invoke("ingest_raw_async", { rawPath: prefs.rawPath, notePath: prefs.notePath, reset: false });
                }
                setToast({ message: "Saved & ingesting...", type: "info" });
              }
            } catch {
              setToast({ message: "Save failed", type: "error" });
            }
          }}
        />
      );
    }
    if (activeChannel === "sync-rate") return <SyncRatePanel />;
    // Tag channels: "tag:learn", "tag:work", etc.
    if (activeChannel.startsWith("tag:")) {
      return <TagView tag={activeChannel.slice(4)} />;
    }
    const view = views.find((v) => v.key === activeChannel);
    if (view) return <ViewPanel viewKey={view.key} title={view.title} path={view.path} />;
    return <div className="flex items-center justify-center h-full text-text-muted text-[13px]">Select a page</div>;
  }

  return (
    <div className="proto-app h-screen">
      <Sidebar
        activeChannel={activeChannel}
        onSelect={setActiveChannel}
        views={views}
        tags={tags}
        onTagsChanged={refreshTags}
        gatewayOnline={health.gatewayOnline}
        ingestBusy={ingestBusy}
        embeddingMode={health.embeddingMode}
        kbVersion={ingestSteps.some(s => s.status === "done") ? `v${Date.now()}` : undefined}
      />
      <main className="flex-1 min-w-0 overflow-hidden bg-[var(--color-bg-primary)]">
        {renderMainPanel()}
      </main>
      <AnimatePresence>
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </AnimatePresence>
    </div>
  );
}
