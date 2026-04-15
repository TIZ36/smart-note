import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2 } from "lucide-react";
import * as api from "@/lib/api";

type Props = {
  onSelectSource?: (filePath: string) => void;
};

type SimNode = api.WikiGraphNode & {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
};

const W = 400;
const H = 300;
const PAD = 30;

export function WikiGraph({ onSelectSource }: Props) {
  const [data, setData] = useState<api.WikiGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const rafRef = useRef<number>(0);
  const dragRef = useRef<string | null>(null);
  const cooledRef = useRef(false);

  useEffect(() => {
    setLoading(true);
    api
      .fetchWikiGraph()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  // Build initial node positions + start simulation
  useEffect(() => {
    if (!data || data.nodes.length === 0) return;

    const cx = W / 2;
    const cy = H / 2;
    const spread = Math.min(100, 30 + data.nodes.length * 12);

    nodesRef.current = data.nodes.map((n, i) => {
      const angle = (2 * Math.PI * i) / data.nodes.length - Math.PI / 2;
      const isNote = !!(n as any).is_note;
      const r = isNote
        ? Math.max(22, Math.min(32, 14 + n.chunk_count * 0.3))
        : Math.max(16, Math.min(28, 10 + n.chunk_count * 0.5));
      return {
        ...n,
        x: cx + spread * Math.cos(angle) + (Math.random() - 0.5) * 20,
        y: cy + spread * Math.sin(angle) + (Math.random() - 0.5) * 20,
        vx: 0,
        vy: 0,
        r,
      };
    });

    cooledRef.current = false;
    startSim();

    return () => cancelAnimationFrame(rafRef.current);
  }, [data]);

  function applyForces(alpha: number) {
    const nodes = nodesRef.current;
    const edges = data?.edges ?? [];

    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x || 0.1;
        const dy = nodes[j].y - nodes[i].y || 0.1;
        const dist2 = dx * dx + dy * dy;
        const dist = Math.sqrt(dist2);
        const f = (3000 * alpha) / dist2;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        nodes[i].vx -= fx;
        nodes[i].vy -= fy;
        nodes[j].vx += fx;
        nodes[j].vy += fy;
      }
    }

    // Attraction along edges
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const e of edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (dist - 80) * 0.02 * alpha;
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Center gravity
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.005 * alpha;
      n.vy += (H / 2 - n.y) * 0.005 * alpha;
    }

    // Integrate
    for (const n of nodes) {
      if (dragRef.current === n.id) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= 0.6;
      n.vy *= 0.6;
      n.x = Math.max(PAD, Math.min(W - PAD, n.x + n.vx));
      n.y = Math.max(PAD, Math.min(H - PAD, n.y + n.vy));
    }
  }

  function paintDOM() {
    const svg = svgRef.current;
    if (!svg) return;
    const nodes = nodesRef.current;
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Update edges
    svg.querySelectorAll<SVGLineElement>("[data-edge]").forEach((el) => {
      const [s, t] = (el.dataset.edge ?? "").split("|");
      const a = byId.get(s);
      const b = byId.get(t);
      if (!a || !b) return;
      el.setAttribute("x1", String(a.x));
      el.setAttribute("y1", String(a.y));
      el.setAttribute("x2", String(b.x));
      el.setAttribute("y2", String(b.y));
    });

    // Update sim labels
    svg.querySelectorAll<SVGTextElement>("[data-sim]").forEach((el) => {
      const [s, t] = (el.dataset.sim ?? "").split("|");
      const a = byId.get(s);
      const b = byId.get(t);
      if (!a || !b) return;
      el.setAttribute("x", String((a.x + b.x) / 2));
      el.setAttribute("y", String((a.y + b.y) / 2 - 4));
    });

    // Update node groups
    svg.querySelectorAll<SVGGElement>("[data-nid]").forEach((g) => {
      const n = byId.get(g.dataset.nid!);
      if (!n) return;
      const circle = g.querySelector("circle");
      const text = g.querySelector("text");
      if (circle) {
        circle.setAttribute("cx", String(n.x));
        circle.setAttribute("cy", String(n.y));
      }
      if (text) {
        text.setAttribute("x", String(n.x));
        text.setAttribute("y", String(n.y + n.r + 12));
      }
    });
  }

  function startSim() {
    cancelAnimationFrame(rafRef.current);
    let frame = 0;
    const max = 300;
    cooledRef.current = false;

    const tick = () => {
      if (frame >= max) {
        cooledRef.current = true;
        return;
      }
      frame++;
      const alpha = 0.3 * (1 - frame / max);
      applyForces(alpha);
      paintDOM();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  // Reheat simulation (e.g. after drag release)
  function reheat() {
    cancelAnimationFrame(rafRef.current);
    let frame = 0;
    const max = 80;
    cooledRef.current = false;

    const tick = () => {
      if (frame >= max) {
        cooledRef.current = true;
        return;
      }
      frame++;
      const alpha = 0.15 * (1 - frame / max);
      applyForces(alpha);
      paintDOM();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  // -- Drag via SVG coordinate transform --
  const svgPoint = useCallback((e: React.PointerEvent) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM()!.inverse());
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent, nodeId: string) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as Element).setPointerCapture(e.pointerId);
      dragRef.current = nodeId;
      cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const p = svgPoint(e);
    const n = nodesRef.current.find((n) => n.id === dragRef.current);
    if (!n) return;
    n.x = Math.max(PAD, Math.min(W - PAD, p.x));
    n.y = Math.max(PAD, Math.min(H - PAD, p.y));
    n.vx = 0;
    n.vy = 0;
    paintDOM();
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    reheat();
  }, []);

  // -- Render (only once per data load; DOM updates happen via paintDOM) --
  if (loading) {
    return (
      <div className="proto-wiki-graph-empty">
        <Loader2
          size={16}
          className="animate-spin"
          style={{ color: "var(--color-text-muted)" }}
        />
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

  const initNodes = nodesRef.current;
  const selectedNode = selected
    ? initNodes.find((n) => n.id === selected)
    : null;

  return (
    <div className="proto-wiki-graph">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="proto-wiki-graph-svg"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {/* Edges */}
        {data.edges.map((edge, i) => {
          const opacity = Math.min(0.8, 0.2 + (edge.weight / 10) * 0.5);
          return (
            <line
              key={i}
              data-edge={`${edge.source}|${edge.target}`}
              className="proto-wiki-graph-edge"
              strokeWidth={Math.max(1, Math.min(3, edge.weight * 0.4))}
              strokeOpacity={opacity}
            />
          );
        })}

        {/* Similarity labels */}
        {data.edges.map((edge, i) =>
          edge.similarity ? (
            <text
              key={`s${i}`}
              data-sim={`${edge.source}|${edge.target}`}
              textAnchor="middle"
              className="proto-wiki-graph-sim-label"
            >
              {(edge.similarity * 100).toFixed(0)}%
            </text>
          ) : null,
        )}

        {/* Nodes */}
        {initNodes.map((node) => {
          const isNote = !!(node as any).is_note;
          const cls = [
            "proto-wiki-graph-node",
            selected === node.id && "proto-wiki-graph-node-active",
            isNote && "proto-wiki-graph-node-note",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <g
              key={node.id}
              data-nid={node.id}
              className={cls}
              style={{ cursor: "grab" }}
              onPointerDown={(e) => onPointerDown(e, node.id)}
              onClick={() =>
                setSelected((s) => (s === node.id ? null : node.id))
              }
            >
              <circle cx={node.x} cy={node.y} r={node.r} />
              <text
                x={node.x}
                y={node.y + node.r + 12}
                textAnchor="middle"
                className="proto-wiki-graph-label"
              >
                {node.name.length > 12
                  ? node.name.slice(0, 12) + "\u2026"
                  : node.name}
              </text>
            </g>
          );
        })}
      </svg>

      {selectedNode && (
        <div className="proto-wiki-graph-detail">
          <div className="proto-wiki-graph-detail-name">
            {selectedNode.name}
          </div>
          {selectedNode.summary && (
            <p className="proto-wiki-graph-detail-summary">
              {selectedNode.summary}
            </p>
          )}
          <div className="proto-wiki-graph-detail-meta">
            {selectedNode.chunk_count} chunks &middot;{" "}
            {selectedNode.files.length} files
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
                  <span className="proto-wiki-graph-file-count">
                    {f.chunks}
                  </span>
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
