import { cn } from "../../lib/cn";
import type { SearchResult } from "../../lib/types";

type Props = {
  index: number;
  result: SearchResult;
  highlighted?: boolean;
  starred?: boolean;
  onClick?: () => void;
};

export function SourceCard({ index, result, highlighted, onClick }: Props) {
  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
      className={cn(
        "proto-source-card",
        highlighted && "proto-source-card-active"
      )}
    >
      <div className="proto-source-meta">
        <span>{index}</span>
        <span className={cn("proto-source-meta-dim", `proto-tag-color-${result._tagColor || "gray"}`)}>{result.dimension}</span>
        {result.segment_range && (
          <span style={{ fontSize: 10, color: "var(--color-accent)", fontFamily: "ui-monospace, monospace" }}>{result.segment_range}</span>
        )}
        {result.segment_topic && (
          <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{result.segment_topic}</span>
        )}
        <span className="proto-source-meta-score">
          {Number(result.score || 0).toFixed(2)}
        </span>
      </div>
      <p className="proto-source-text">{result.text}</p>
      {result.source_ref && <p className="proto-source-ref">{result.source_ref}</p>}
    </div>
  );
}
