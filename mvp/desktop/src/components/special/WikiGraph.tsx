import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import * as api from "@/lib/api";

type Props = {
  onSelectSource?: (filePath: string) => void;
};

type LayoutNode = api.WikiGraphNode & { x: number; y: number };

export function WikiGraph({ onSelectSource }: Props) {
  const [data, setData] = useState<api.WikiGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    setLoading(true);
    api.fetchWikiGraph()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  // Simple radial layout
  const layout = useCallback((): LayoutNode[] => {
    if (!data || data.nodes.length === 0) return [];
    const nodes = data.nodes;
    if (nodes.length === 1) {
      return [{ ...nodes[0], x: 200, y: 150 }];
    }
    const cx = 200;
    const cy = 150;
    const r = Math.min(120, 40 * nodes.length);
    return nodes.map((n, i) => {
      const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
      return { ...n, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    });
  }, [data]);

  if (loading) {
    return (
      <div className="proto-wiki-graph-empty">
        <Loader2 size={16} className="animate-spin" style={{ color: "var(--color-text-muted)" }} />
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="proto-wiki-graph-empty">
        <span>No topics to graph</span>
      </div>
    );
  }

  const nodes = layout();
  const nodeMap = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const selectedNode = selected ? nodeMap[selected] : null;

  return (
    <div className="proto-wiki-graph">
      {/* SVG graph */}
      <svg
        ref={svgRef}
        viewBox="0 0 400 300"
        className="proto-wiki-graph-svg"
      >
        {/* Edges */}
        {data.edges.map((edge, i) => {
          const src = nodeMap[edge.source];
          const tgt = nodeMap[edge.target];
          if (!src || !tgt) return null;
          return (
            <line
              key={i}
              x1={src.x}
              y1={src.y}
              x2={tgt.x}
              y2={tgt.y}
              className="proto-wiki-graph-edge"
              strokeWidth={Math.min(edge.weight * 0.5, 3)}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const isSelected = selected === node.id;
          const r = Math.max(16, Math.min(28, 10 + node.chunk_count * 0.5));
          return (
            <g
              key={node.id}
              className={cn("proto-wiki-graph-node", isSelected && "proto-wiki-graph-node-active")}
              onClick={() => setSelected(isSelected ? null : node.id)}
              style={{ cursor: "pointer" }}
            >
              <circle cx={node.x} cy={node.y} r={r} />
              <text x={node.x} y={node.y + r + 12} textAnchor="middle" className="proto-wiki-graph-label">
                {node.name.length > 12 ? node.name.slice(0, 12) + "…" : node.name}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Detail panel for selected node */}
      {selectedNode && (
        <div className="proto-wiki-graph-detail">
          <div className="proto-wiki-graph-detail-name">{selectedNode.name}</div>
          {selectedNode.summary && (
            <p className="proto-wiki-graph-detail-summary">{selectedNode.summary}</p>
          )}
          <div className="proto-wiki-graph-detail-meta">
            {selectedNode.chunk_count} chunks · {selectedNode.files.length} files
          </div>
          {selectedNode.files.length > 0 && (
            <div className="proto-wiki-graph-detail-files">
              {selectedNode.files.slice(0, 10).map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className="proto-wiki-graph-file-btn"
                  onClick={() => onSelectSource?.(f.path)}
                >
                  {f.path.split("/").pop()}
                  <span className="proto-wiki-graph-file-count">{f.chunks}</span>
                </button>
              ))}
              {selectedNode.files.length > 10 && (
                <span className="proto-wiki-graph-file-more">
                  +{selectedNode.files.length - 10} more
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
