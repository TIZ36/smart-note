import { Database, Sparkles, Layers } from "lucide-react";
import { cn } from "@/lib/cn";
import type { CloudDocument } from "@/lib/cloud-api";
import type { BulkRuns } from "./useBulkRuns";

/* BulkActionBar — Embed / Enrich / Wiki-smartsheet across selected
 * docs. Renders only when ≥1 doc is checked in the tree.
 *
 * The action labels flip between fresh ("Embedding 3 sources") and
 * re-run ("Re-embed — all 3 already complete") so the user always
 * knows whether a click is destructive (idempotent overwrite) vs.
 * additive.
 */

type DocKind = "note" | "wiki_topic" | "doc";

function kindOf(d: CloudDocument): DocKind {
  const md = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Record<string, unknown>;
  const snt = String(md.smartnote_type || "");
  if (snt === "wiki_topic") return "wiki_topic";
  if (snt === "note") return "note";
  return "doc";
}

type Props = {
  selected: Set<string>;
  docs: CloudDocument[];
  bulk: BulkRuns;
  onClearSelection: () => void;
};

export function BulkActionBar({ selected, docs, bulk, onClearSelection }: Props) {
  const selectedDocs = docs.filter((d) => selected.has(d.id));

  // E/R/T fresh-vs-done counts drive the action-tile copy. Embed
  // truth = ingested_at != null. Enrich/Tag truth = ai_tags or
  // metadata.enrich_status — kept loose since metadata can lag.
  const total = selectedDocs.length;
  const embFresh = selectedDocs.filter((s) => !s.ingested_at).length;
  const embDone  = total - embFresh;
  const enrFresh = selectedDocs.filter((s) => {
    const md = (s.metadata || {}) as Record<string, unknown>;
    return !(Array.isArray(md.ai_tags) && (md.ai_tags as unknown[]).length > 0);
  }).length;
  const enrDone = total - enrFresh;
  const wikiSelCount = selectedDocs.filter((d) => kindOf(d) === "wiki_topic").length;

  function actionDesc(stage: "embed" | "enrich"): string {
    const fresh = stage === "embed" ? embFresh : enrFresh;
    const done  = stage === "embed" ? embDone  : enrDone;
    if (total === 0) {
      return stage === "embed"
        ? "Re-chunk + re-embed selected sources. No LLM calls."
        : "LLM classifier + tag generation + segment summaries.";
    }
    if (fresh === 0 && done > 0) {
      return `All ${done} already complete. Click to re-run from scratch.`;
    }
    if (fresh > 0 && done > 0) {
      return `${fresh} new · ${done} refresh.`;
    }
    return stage === "embed"
      ? `${fresh} source${fresh === 1 ? "" : "s"} not yet embedded.`
      : `${fresh} source${fresh === 1 ? "" : "s"} not yet enriched.`;
  }
  function actionTitle(stage: "embed" | "enrich"): string {
    const fresh = stage === "embed" ? embFresh : enrFresh;
    const done  = stage === "embed" ? embDone  : enrDone;
    const base = stage === "embed" ? "Embedding" : "Enrich";
    if (total > 0 && fresh === 0 && done > 0) return stage === "embed" ? "Re-embed" : "Re-enrich";
    return base;
  }

  const ids = [...selected];
  const wikiIds = selectedDocs.filter((d) => kindOf(d) === "wiki_topic").map((d) => d.id);
  const cloudReadyText = bulk.cloudProviderReady === false
    ? "Cloud AI provider not set — open Cloud panel to add one."
    : null;

  return (
    <div className="proto-atelier-rag-section" style={{ margin: "0 0 12px" }}>
      <div className="proto-atelier-rag-section-head">
        <h3 className="proto-atelier-rag-section-title">Process selected</h3>
        <div className="proto-atelier-rag-section-meta">
          {total} source{total === 1 ? "" : "s"} selected
          <button
            type="button"
            onClick={onClearSelection}
            style={{ marginLeft: 12, fontSize: 11, textDecoration: "underline", background: "none", border: "none", color: "var(--color-text-muted)", cursor: "pointer" }}
          >
            clear
          </button>
        </div>
      </div>
      <div className="proto-atelier-rag-actions-grid">
        <ActionTile
          icon={<Database size={14} />}
          title={actionTitle("embed")}
          tone="non-llm"
          desc={actionDesc("embed")}
          disabled={total === 0 || bulk.busyKinds.has("embed")}
          running={bulk.busyKinds.has("embed")}
          progress={bulk.runStats.embed.total > 0
            ? { done: bulk.runStats.embed.done + bulk.runStats.embed.failed, total: bulk.runStats.embed.total }
            : undefined}
          onClick={() => bulk.runEmbed(ids)}
        />
        <ActionTile
          icon={<Sparkles size={14} />}
          title={actionTitle("enrich")}
          tone="llm"
          desc={cloudReadyText || actionDesc("enrich")}
          disabled={total === 0 || bulk.busyKinds.has("enrich") || bulk.cloudProviderReady === false}
          running={bulk.busyKinds.has("enrich")}
          progress={bulk.runStats.enrich.total > 0
            ? { done: bulk.runStats.enrich.done + bulk.runStats.enrich.failed, total: bulk.runStats.enrich.total }
            : undefined}
          onClick={() => bulk.runEnrich(ids)}
        />
        <ActionTile
          icon={<Layers size={14} />}
          title="Build wiki-smartsheet"
          tone="llm"
          desc={
            cloudReadyText ||
            (wikiSelCount === 0
              ? "Per-chapter concept matrix. Select Wiki docs first."
              : `${wikiSelCount} wiki doc${wikiSelCount === 1 ? "" : "s"} selected — extract chapter concepts.`)
          }
          disabled={wikiSelCount === 0 || bulk.busyKinds.has("tag") || bulk.cloudProviderReady === false}
          running={bulk.busyKinds.has("tag")}
          progress={bulk.runStats.tag.total > 0
            ? { done: bulk.runStats.tag.done + bulk.runStats.tag.failed, total: bulk.runStats.tag.total }
            : undefined}
          onClick={() => bulk.runWikiSmartsheet(wikiIds)}
        />
      </div>
    </div>
  );
}

function ActionTile({
  icon, title, desc, tone, onClick, disabled, running, progress,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  tone: "llm" | "non-llm";
  onClick: () => void;
  disabled?: boolean;
  running?: boolean;
  progress?: { done: number; total: number };
}) {
  const pct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "proto-atelier-rag-action",
        tone === "llm" && "proto-atelier-rag-action-llm",
        tone === "non-llm" && "proto-atelier-rag-action-nonllm",
        running && "proto-atelier-rag-action-running",
      )}
    >
      <span className="proto-atelier-rag-action-icon">{icon}</span>
      <div className="proto-atelier-rag-action-body">
        <div className="proto-atelier-rag-action-head">
          <span className="proto-atelier-rag-action-title">{title}</span>
          {tone === "llm"
            ? <span className="proto-atelier-rag-action-pill">LLM</span>
            : <span className="proto-atelier-rag-action-pill proto-atelier-rag-action-pill-cheap">no-LLM</span>}
          {progress && (
            <span className="proto-atelier-rag-action-pill proto-atelier-rag-action-pill-progress">
              {progress.done}/{progress.total}
            </span>
          )}
        </div>
        <div className="proto-atelier-rag-action-desc">
          {running && progress
            ? `${progress.done}/${progress.total} done · running…`
            : running ? "running…" : desc}
        </div>
        {progress && (
          <div className="proto-atelier-rag-action-bar">
            <span
              className="proto-atelier-rag-action-bar-fill"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
    </button>
  );
}
