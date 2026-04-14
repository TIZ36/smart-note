import { useState, useEffect } from "react";
import { X, FileText, Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";
import * as api from "../../lib/api";
import type { SourcePreviewData } from "../../lib/types";

type Props = {
  sourceRef: string;
  onClose: () => void;
};

export function SourcePreview({ sourceRef, onClose }: Props) {
  const [data, setData] = useState<SourcePreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    api.fetchSource(sourceRef).then(setData).catch((e) => setError(String(e))).finally(() => setLoading(false));
  }, [sourceRef]);

  const fileName = data?.file?.split("/").pop() || sourceRef;

  return (
    <div className="flex flex-col h-full bg-bg-sidebar border-l border-border">
      <div className="h-10 flex items-center px-3 gap-2 border-b border-border shrink-0">
        <FileText size={13} className="text-text-muted" />
        <span className="text-[11px] text-text-secondary font-mono truncate flex-1">
          {fileName}:{data?.target_line}
        </span>
        <button onClick={onClose} className="p-1 rounded hover:bg-bg-hover transition-colors">
          <X size={13} className="text-text-muted" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto font-mono text-[12px] leading-relaxed">
        {loading && (
          <div className="flex items-center gap-2 p-4 text-text-muted">
            <Loader2 size={13} className="animate-spin" /> Loading...
          </div>
        )}
        {error && <div className="p-4 text-danger text-[12px]">{error}</div>}
        {data && data.lines.map((line) => (
          <div
            key={line.line}
            className={cn(
              "flex px-3 py-px",
              line.highlight ? "bg-warning/8" : "hover:bg-bg-hover"
            )}
          >
            <span className="w-8 text-right text-text-muted/40 select-none shrink-0 mr-3 tabular-nums">
              {line.line}
            </span>
            <span className={cn("flex-1 whitespace-pre-wrap", line.highlight ? "text-text-primary" : "text-text-secondary")}>
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
