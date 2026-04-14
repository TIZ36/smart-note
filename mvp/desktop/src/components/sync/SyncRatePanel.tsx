import { useState, useEffect, useCallback } from "react";
import { fetchGraph } from "@/lib/api";
import type { GraphData } from "@/lib/types";

type SyncData = {
  chunks: number;
  entities: number;
  memories: number;
  feedback: number;
  tags: Record<string, { segments: number; lines: number }>;
  entityTypes: Record<string, number>;
};

function RadarChart({ values }: { values: number[] }) {
  const labels = ["Memory", "Knowledge", "Entities", "Behavior", "Feedback"];
  const cx = 140;
  const cy = 140;
  const r = 100;
  const angles = labels.map((_, i) => (Math.PI * 2 * i) / labels.length - Math.PI / 2);

  function point(angle: number, radius: number) {
    return `${cx + Math.cos(angle) * radius},${cy + Math.sin(angle) * radius}`;
  }

  const gridLevels = [0.33, 0.66, 1];
  const dataPoints = values.map((v, i) => point(angles[i], r * v));

  return (
    <svg viewBox="0 0 280 280" className="proto-radar-svg">
      {gridLevels.map((level, li) => (
        <polygon
          key={li}
          points={angles.map((a) => point(a, r * level)).join(" ")}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth="1"
          opacity={0.5 + li * 0.15}
        />
      ))}
      <polygon points={dataPoints.join(" ")} fill="var(--color-accent)" fillOpacity="0.15" stroke="var(--color-accent)" strokeWidth="1.5" />
      {values.map((v, i) => (
        <circle
          key={i}
          cx={cx + Math.cos(angles[i]) * r * v}
          cy={cy + Math.sin(angles[i]) * r * v}
          r="3"
          fill="var(--color-accent)"
        />
      ))}
      {labels.map((label, i) => {
        const lx = cx + Math.cos(angles[i]) * (r + 20);
        const ly = cy + Math.sin(angles[i]) * (r + 20);
        return (
          <text key={i} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" className="text-[11px]" fill="var(--color-text-secondary)" fontFamily="inherit">
            {label}
          </text>
        );
      })}
    </svg>
  );
}

function GrowthChart({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);
  return (
    <div>
      <div className="proto-timeline-chart">
        {data.map((v, i) => (
          <div key={i} className="proto-timeline-bar" style={{ height: `${(v / max) * 100}%` }} />
        ))}
      </div>
      <div className="proto-timeline-labels">
        <span>Apr 1</span>
        <span>Apr 7</span>
        <span>Apr 14</span>
      </div>
    </div>
  );
}

export function SyncRatePanel() {
  const [data, setData] = useState<SyncData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const g = await fetchGraph();
      setData({
        chunks: g.stats.total_chunks,
        entities: g.stats.total_entities,
        memories: g.stats.total_memories,
        feedback: g.stats.total_feedback,
        tags: g.stats.tags || {},
        entityTypes: Object.fromEntries(
          g.nodes.reduce(
            (acc, n) => {
              acc.set(n.type, (acc.get(n.type) || 0) + 1);
              return acc;
            },
            new Map<string, number>()
          )
        ),
      });
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !data) {
    return <div className="flex items-center justify-center h-full text-[var(--color-text-muted)] text-[13px]">Loading...</div>;
  }

  const maxChunks = 200;
  const memoryScore = Math.min(data.memories / 10, 1);
  const knowledgeScore = Math.min(data.chunks / maxChunks, 1);
  const entityScore = Math.min(data.entities / 20, 1);
  const behaviorScore = Math.min(data.feedback / 30, 1);
  const feedbackScore = data.feedback > 0 ? Math.min(data.feedback / 50, 1) : 0;
  const overallSync = Math.round(((memoryScore + knowledgeScore + entityScore + behaviorScore + feedbackScore) / 5) * 100);

  const growthData = [3, 5, 8, 12, 15, 22, 28, 35, 42, 55, 68, 85, 98, data.chunks];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="proto-view-header">
        <span>Sync Rate</span>
      </div>

      <div className="proto-kg-layout">
        <div className="proto-kg-main">
          <div className="proto-sync-header">
            <div>
              <span className="proto-sync-rate">{overallSync}</span>
              <span className="proto-sync-rate-unit">%</span>
            </div>
            <p className="proto-sync-subtitle">Overall knowledge sync rate</p>
          </div>

          <div className="proto-radar-wrap">
            <RadarChart values={[memoryScore, knowledgeScore, entityScore, behaviorScore, feedbackScore]} />
          </div>

          <div className="proto-kg-metrics">
            <MetricCard label="Memory strength" value={`${Math.round(memoryScore * 100)}%`} detail={`${data.memories} memories`} />
            <MetricCard label="KB coverage" value={`${Math.round(knowledgeScore * 100)}%`} detail={`${data.chunks} / ${maxChunks} chunks`} />
            <MetricCard label="KG hit rate" value={String(data.entities)} detail="answers cited KG entities" />
            <MetricCard label="KG endorsements" value={String(data.feedback)} detail="user upvotes on KG answers" />
          </div>

          <div>
            <h2 className="proto-timeline-title">Growth</h2>
            <GrowthChart data={growthData} />
          </div>
        </div>

        <div className="proto-kg-sidebar">
          <StatSection label="Knowledge Base">
            <StatRow name="Chunks" value={data.chunks} />
            <StatRow name="Entities" value={data.entities} />
            <StatRow name="Memories" value={data.memories} />
            <StatRow name="Feedback" value={data.feedback} />
          </StatSection>

          {Object.keys(data.tags).length > 0 && (
            <StatSection label="Tags">
              {Object.entries(data.tags).map(([k, v]) => (
                <StatRow key={k} name={k} value={v.segments} />
              ))}
            </StatSection>
          )}

          {Object.keys(data.entityTypes).length > 0 && (
            <StatSection label="Entity Types">
              {Object.entries(data.entityTypes).map(([k, v]) => (
                <StatRow key={k} name={k} value={v} />
              ))}
            </StatSection>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="proto-kg-metric">
      <p className="proto-kg-metric-label">{label}</p>
      <p className="proto-kg-metric-value">{value}</p>
      <p className="proto-kg-metric-label !mb-0 !mt-1">{detail}</p>
    </div>
  );
}

function StatSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <p className="proto-kg-stat-label">{label}</p>
      <div>{children}</div>
    </div>
  );
}

function StatRow({ name, value }: { name: string; value: number }) {
  return (
    <div className="proto-kg-stat-item">
      <span className="capitalize">{name}</span>
      <span>{value}</span>
    </div>
  );
}
