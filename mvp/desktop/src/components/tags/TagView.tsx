import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { cn } from "../../lib/cn";
import * as api from "../../lib/api";

type Props = {
  tag: string;
};

export function TagView({ tag }: Props) {
  const [segments, setSegments] = useState<api.TagSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSegment, setActiveSegment] = useState<number | null>(null);
  const [sourceLines, setSourceLines] = useState<{ line: number; text: string }[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setActiveSegment(null);
    setSourceLines([]);
    api.fetchTagSegments(tag)
      .then((d) => setSegments(d.segments))
      .catch(() => setSegments([]))
      .finally(() => setLoading(false));
  }, [tag]);

  async function handleViewSource(segmentId: number) {
    if (activeSegment === segmentId) {
      setActiveSegment(null);
      setSourceLines([]);
      return;
    }
    setActiveSegment(segmentId);
    setSourceLoading(true);
    try {
      const data = await api.fetchTagSource(tag, segmentId);
      setSourceLines(data.lines);
    } catch {
      setSourceLines([]);
    } finally {
      setSourceLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="proto-view-header">
        <span>{tag}</span>
        <span className="proto-view-header-file">
          {segments.length} segments
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="proto-page-content" style={{ maxWidth: 640 }}>
          {loading && (
            <p className="proto-search-hint">Loading...</p>
          )}

          {!loading && segments.length === 0 && (
            <p className="proto-search-hint">
              No content in this tag yet. Ingest notes to classify content.
            </p>
          )}

          {segments.map((seg) => (
            <div key={seg.id} className="proto-tag-segment">
              {/* Segment header */}
              <div className="proto-tag-segment-header">
                <span className="proto-tag-segment-range">
                  L{seg.line_start}–{seg.line_end}
                </span>
                {seg.topic_name && (
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)" }}>{seg.topic_name}</span>
                )}
                {seg.is_credential && (
                  <span className="proto-tag-credential-badge">credential</span>
                )}
                <span className="proto-tag-segment-summary">{seg.summary}</span>
                <button
                  type="button"
                  onClick={() => handleViewSource(seg.id)}
                  className={cn(
                    "proto-tag-view-btn",
                    activeSegment === seg.id && "proto-tag-view-btn-active"
                  )}
                >
                  {activeSegment === seg.id ? "Hide" : "View source"}
                </button>
              </div>

              {/* Keywords */}
              {seg.keywords.length > 0 && (
                <div className="proto-tag-keywords">
                  {seg.keywords.map((kw, i) => (
                    <span key={i} className="proto-tag-keyword">{kw}</span>
                  ))}
                </div>
              )}

              {/* Source lines (expandable) */}
              {activeSegment === seg.id && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="proto-tag-source"
                >
                  {sourceLoading ? (
                    <p className="proto-search-hint">Loading source...</p>
                  ) : (
                    sourceLines.map((ln) => (
                      <div key={ln.line} className="proto-tag-source-line">
                        <span className="proto-tag-source-linenum">{ln.line}</span>
                        <span className="proto-tag-source-text">{ln.text}</span>
                      </div>
                    ))
                  )}
                </motion.div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
