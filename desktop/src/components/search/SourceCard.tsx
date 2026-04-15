import { BookOpen } from "lucide-react";
import { cn } from "../../lib/cn";
import type { SearchResult } from "../../lib/types";

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
