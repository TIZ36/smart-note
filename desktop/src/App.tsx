import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence } from "framer-motion";
import { Sidebar } from "./components/layout/Sidebar";
import { NihoParticles } from "./components/layout/NihoParticles";
import { SearchPage } from "./components/search/SearchPage";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { CloudConsolePage } from "./components/cloud-console/CloudConsolePage";
import { InsightsPanel } from "./components/dashboard/InsightsPanel";
import { SkillsPanel } from "./components/skills/SkillsPanel";
import { WikiSourcesPanel } from "./components/wiki/WikiSourcesPanel";
import { Toast } from "./components/layout/Toast";
import { NotePage } from "./components/note/NotePage";
import { SpecialKnowledgePanel } from "./components/special/SpecialKnowledgePanel";
import { WikiSourceViewer } from "./components/wiki/WikiSourceViewer";
import { SmartTablePanel } from "./components/smart-table/SmartTablePanel";
import { SmartTablesHome } from "./components/smart-table/SmartTablesHome";
import { usePrefs } from "./hooks/usePrefs";
import { useHealth } from "./hooks/useHealth";
import { useSearchState } from "./hooks/useSearchState";
import { useTags } from "./hooks/useTags";
import { useTheme } from "./hooks/useTheme";
import { onIngestStatus, onWikiIngestStatus, getIngestStatus } from "./lib/electron";
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
  // Attribution ('mcp:delegate' | 'provider:<model>' | undefined)
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

export default function App() {
  const [activeChannel, setActiveChannel] = useState<ChannelId>("search");
  const [toast, setToast] = useState<{ message: string; type: "info" | "success" | "error" } | null>(null);
  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestSteps, setIngestSteps] = useState<IngestStep[]>([]);
  const [ingestResult, setIngestResult] = useState<{ message: string; type: "success" | "error" } | null>(null);
  // Bumped on ingest completion AND build activation — downstream views
  // (tag segments, etc.) key their re-fetch on this.
  const [buildVersion, setBuildVersion] = useState(0);

  // Wiki ingest — separate from note ingest
  const [wikiIngestBusy, setWikiIngestBusy] = useState(false);
  const [wikiIngestSteps, setWikiIngestSteps] = useState<IngestStep[]>([]);
  const [wikiIngestResult, setWikiIngestResult] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [wikiTopicCount, setWikiTopicCount] = useState(0);

  const prefs = usePrefs();
  const health = useHealth();
  const { tags, refreshTags } = useTags();
  const searchState = useSearchState();
  const { mode: themeMode } = useTheme();
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
          if (s.key === event.step) return { ...s, status: "active", detail: event.message, current: event.current, total: event.total, elapsedMs: event.elapsed_ms, actor: event.actor, kind: event.kind };
          const thisIdx = STEP_ORDER.indexOf(s.key);
          const eventIdx = STEP_ORDER.indexOf(event.step);
          if (thisIdx < eventIdx && s.status !== "done") return { ...s, status: "done" };
          return s;
        }));
        // MCP-delegated enrich fires after initial ingest done — make sure
        // spinner is visible and tag views refresh when it completes.
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

  // Wiki ingest listener — isolated from note ingest
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

  // Recover ingest state after client reload
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

  const handleIngestComplete = useCallback(() => {
    refreshTags();
    setBuildVersion((v) => v + 1);
  }, [refreshTags]);

  function handleWikiTopicsChanged(count: number) {
    setWikiTopicCount(count);
  }

  function renderMainPanel() {
    if (activeChannel === "settings") return <SettingsPanel />;
    if (activeChannel === "cloud-sync") return <CloudConsolePage />;
    if (activeChannel === "insights" || activeChannel === "dashboard" || activeChannel === "meta-memory") {
      return <InsightsPanel gatewayOnline={health.gatewayOnline} embeddingMode={health.embeddingMode} />;
    }
    if (activeChannel === "skills") return <SkillsPanel />;
    if (activeChannel === "source-list") {
      return <WikiSourcesPanel onSelectSource={(path) => setActiveChannel(`source:${path}` as ChannelId)} />;
    }
    if (activeChannel === "search") return <SearchPage searchState={searchState} tags={tags} />;
    if (activeChannel === "smart-table") {
      return <SmartTablesHome onOpenTable={(name) => setActiveChannel(`smart-table:${name}` as ChannelId)} />;
    }
    if (activeChannel.startsWith("smart-table:")) {
      const tableName = activeChannel.slice("smart-table:".length);
      return <SmartTablePanel tableName={tableName} onDeleted={() => setActiveChannel("smart-table")} />;
    }
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
    if (activeChannel === "special-knowledge") return <SpecialKnowledgePanel ingestBusy={wikiIngestBusy} ingestSteps={wikiIngestSteps} ingestResult={wikiIngestResult} onTopicsChanged={handleWikiTopicsChanged} onSelectSource={(path) => setActiveChannel(`source:${path}` as ChannelId)} />;
    if (activeChannel.startsWith("source:")) {
      const filePath = activeChannel.slice("source:".length);
      return <WikiSourceViewer filePath={filePath} />;
    }
    return <div className="flex items-center justify-center h-full text-text-muted text-[13px]">Select a page</div>;
  }

  return (
    <div className="proto-app h-screen">
      {themeMode === "niho" && <NihoParticles />}
      <Sidebar
        activeChannel={activeChannel}
        onSelect={setActiveChannel}
        ingestBusy={ingestBusy}
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
