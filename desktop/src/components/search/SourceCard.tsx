import { BookOpen } from "lucide-react";
import { cn } from "../../lib/cn";
import type { SearchResult, SearchResultPathScores } from "../../lib/types";

type Props = {
  index: number;
  result: SearchResult;
  highlighted?: boolean;
  starred?: boolean;
  onClick?: () => void;
};

export function SourceCard({ index, result, highlighted, starred, onClick }: Props) {
  const isWiki = result.is_wiki || result.dimension?.startsWith("wiki:");
  const displayDim = isWiki ? result.dimension.replace(/^wiki:/, "") : result.dimension;

  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
      className={cn(
        "proto-source-card",
        highlighted && "proto-source-card-active",
        isWiki && "proto-source-card-wiki-tint"
      )}
    >
      <div className="proto-source-meta">
        <span className={cn(starred && "proto-source-meta-starred")}>{index}</span>
        {isWiki && <BookOpen size={12} className="proto-wiki-badge-icon" />}
        <span className={cn("proto-source-meta-dim", isWiki ? "proto-wiki-dim" : `proto-tag-color-${result._tagColor || "gray"}`)}>{displayDim}</span>
        {result.segment_range && (
          <span className="proto-source-meta-range">{result.segment_range}</span>
        )}
        {result.segment_topic && (
          <span className="proto-source-meta-topic">{result.segment_topic}</span>
        )}
        <span className="proto-source-meta-score">
          {Number(result.score || 0).toFixed(2)}
        </span>
      </div>
      <p className="proto-source-text">{result.text}</p>
      {result.source_ref && <SourceRef value={result.source_ref} />}
      {result.path_scores && <PathBreakdown scores={result.path_scores} />}
    </div>
  );
}

/* 6-path fusion breakdown — renders only the paths that contributed
   (score > 0) so the chip row stays compact. On hover each chip shows
   the raw value; absence of a chip is itself the message ("vector
   alone didn't find this, substring did").

   This is the ONLY place in the UI where the "we're a hybrid retriever,
   not another single-path RAG" claim becomes visible to the user. */
const PATH_META: { key: keyof SearchResultPathScores; label: string; title: string }[] = [
  { key: "fts",      label: "FTS",   title: "Full-text (FTS5) — token match" },
  { key: "sub",      label: "sub",   title: "Substring — raw LIKE scan" },
  { key: "ngram",    label: "ngram", title: "Character n-gram overlap" },
  { key: "vec",      label: "vec",   title: "Cosine similarity on embeddings" },
  { key: "kw",       label: "kw",    title: "AI-extracted keyword overlap" },
  { key: "tag_meta", label: "tag",   title: "Tag-segment topic / summary / keyword" },
];

function PathBreakdown({ scores }: { scores: SearchResultPathScores }) {
  const hits = PATH_META
    .map((m) => ({ ...m, score: scores[m.key] }))
    .filter((m) => m.score > 0.01);
  if (hits.length === 0) return null;
  return (
    <div className="proto-source-paths" aria-label="Retrieval paths that matched">
      <span className="proto-source-paths-label">paths</span>
      {hits.map((h) => (
        <span
          key={h.key}
          className={`proto-source-path-chip proto-source-path-${h.key}`}
          title={`${h.title} · ${h.score.toFixed(2)}`}
        >
          {h.label}
          <span className="proto-source-path-val">{h.score.toFixed(2)}</span>
        </span>
      ))}
    </div>
  );
}

/** Parse source_ref like "filename.md:line:10-25" into styled parts */
function SourceRef({ value }: { value: string }) {
  // Format: "path/file.ext:line:start-end" or just a plain string
  const match = value.match(/^(.+?):line:(\d+(?:-\d+)?)$/);
  if (!match) {
    return <p className="proto-source-ref">{value}</p>;
  }
  const [, file, range] = match;
  const name = file.split("/").pop() || file;
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : null;
  return (
    <p className="proto-source-ref">
      {dir && <span className="proto-source-ref-dir">{dir}/</span>}
      <span className="proto-source-ref-file">{name}</span>
      <span className="proto-source-ref-range"> L{range}</span>
    </p>
  );
}
