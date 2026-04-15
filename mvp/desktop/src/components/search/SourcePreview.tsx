import { useState, useEffect, useRef } from "react";
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
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setError("");
    api.fetchSource(sourceRef)
      .then((d) => {
        if (d.lines && d.lines.length > 0) {
          setData(d);
        } else {
          setError("No content returned for this source.");
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [sourceRef]);

  // Scroll to highlighted line after data loads
  useEffect(() => {
    if (data && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [data]);

  const fileName = data?.file?.split("/").pop() || sourceRef;

  return (
    <div className="proto-preview-panel">
      <div className="proto-preview-header">
        <FileText size={13} className="proto-preview-header-icon" />
        <span className="proto-preview-header-file">{fileName}</span>
        {data?.target_line && (
          <span className="proto-preview-header-line">:{data.target_line}</span>
        )}
        <button type="button" onClick={onClose} className="proto-preview-close" aria-label="Close preview">
          <X size={13} />
        </button>
      </div>

      <div className="proto-preview-body">
        {loading && (
          <div className="proto-preview-loading">
            <Loader2 size={14} className="animate-spin" />
            <span>Loading source...</span>
          </div>
        )}
        {error && <div className="proto-preview-error">{error}</div>}
        {data && data.lines.map((line) => (
          <div
            key={line.line}
            ref={line.highlight ? highlightRef : undefined}
            className={cn(
              "proto-preview-line",
              line.highlight && "proto-preview-line-highlight"
            )}
          >
            <span className="proto-preview-line-num">{line.line}</span>
            <span className={cn("proto-preview-line-text", line.highlight && "proto-preview-line-text-active")}>
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
