import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence } from "framer-motion";
import { Sidebar } from "./components/layout/Sidebar";
import { SearchPage } from "./components/search/SearchPage";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { Toast } from "./components/layout/Toast";
import { SyncRatePanel } from "./components/sync/SyncRatePanel";
import { NotePage } from "./components/note/NotePage";
import { SpecialKnowledgePanel } from "./components/special/SpecialKnowledgePanel";
import { usePrefs } from "./hooks/usePrefs";
import { useHealth } from "./hooks/useHealth";
import { useSearchState } from "./hooks/useSearchState";
import { useTags } from "./hooks/useTags";
// TagView removed — tags now expand inline in the NoteSegments panel
import { onIngestStatus, onWikiIngestStatus } from "./lib/electron";
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

const WIKI_STEP_LABELS: Record<string, string> = {
  parse: "Scanning files",
  embed: "Generating embeddings",
  segment: "Text segmentation",
  store: "Storing chunks",
};
const WIKI_STEP_ORDER = ["parse", "embed", "segment", "store"];

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

export default function App() {
  const [activeChannel, setActiveChannel] = useState<ChannelId>("search");
  const [toast, setToast] = useState<{ message: string; type: "info" | "success" | "error" } | null>(null);
  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestSteps, setIngestSteps] = useState<IngestStep[]>([]);
  const [ingestResult, setIngestResult] = useState<{ message: string; type: "success" | "error" } | null>(null);

  // Wiki ingest — separate from note ingest
  const [wikiIngestBusy, setWikiIngestBusy] = useState(false);
  const [wikiIngestSteps, setWikiIngestSteps] = useState<IngestStep[]>([]);
  const [wikiIngestResult, setWikiIngestResult] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [wikiTopicCount, setWikiTopicCount] = useState(0);

  const prefs = usePrefs();
  const health = useHealth();
  const { tags, refreshTags } = useTags();
  const searchState = useSearchState();
  const activeChannelRef = useRef(activeChannel);
  activeChannelRef.current = activeChannel;

  useEffect(() => {
    refreshTags();
  }, [refreshTags]);

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
      } else if (event.status === "error") {
        setIngestBusy(false);
        setIngestResult({ message: event.message, type: "error" });
        setToast({ message: event.message, type: "error" });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Wiki ingest listener — isolated from note ingest
  useEffect(() => {
    const unlisten = onWikiIngestStatus((event: IngestEvent) => {
      if (event.status === "started") {
        setWikiIngestBusy(true);
        setWikiIngestResult(null);
        setWikiIngestSteps(initialWikiSteps());
      } else if (event.status === "progress") {
        setWikiIngestSteps((prev) => prev.map((s) => {
          if (s.key === event.step) return { ...s, status: "active", detail: event.message, current: event.current, total: event.total, elapsedMs: event.elapsed_ms };
          const thisIdx = WIKI_STEP_ORDER.indexOf(s.key);
          const eventIdx = WIKI_STEP_ORDER.indexOf(event.step);
          if (thisIdx < eventIdx && s.status !== "done") return { ...s, status: "done" };
          return s;
        }));
      } else if (event.status === "completed") {
        setWikiIngestBusy(false);
        setWikiIngestSteps((prev) => prev.map((s) => ({ ...s, status: "done" })));
        setWikiIngestResult({ message: event.message, type: "success" });
        setToast({ message: event.message, type: "success" });
      } else if (event.status === "error") {
        setWikiIngestBusy(false);
        setWikiIngestResult({ message: event.message, type: "error" });
        setToast({ message: event.message, type: "error" });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const handleIngestComplete = useCallback(() => {
    refreshTags();
  }, [refreshTags]);

  function renderMainPanel() {
    if (activeChannel === "settings") return <SettingsPanel />;
    if (activeChannel === "search") return <SearchPage searchState={searchState} tags={tags} />;
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
          tags={tags}
          onTagsChanged={refreshTags}
        />
      );
    }
    if (activeChannel === "sync-rate") return <SyncRatePanel />;
    if (activeChannel === "special-knowledge") return <SpecialKnowledgePanel ingestBusy={wikiIngestBusy} ingestSteps={wikiIngestSteps} ingestResult={wikiIngestResult} onTopicsChanged={setWikiTopicCount} />;
    return <div className="flex items-center justify-center h-full text-text-muted text-[13px]">Select a page</div>;
  }

  return (
    <div className="proto-app h-screen">
      <Sidebar
        activeChannel={activeChannel}
        onSelect={setActiveChannel}
        gatewayOnline={health.gatewayOnline}
        ingestBusy={ingestBusy}
        embeddingMode={health.embeddingMode}
        wikiTopicCount={wikiTopicCount}
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
