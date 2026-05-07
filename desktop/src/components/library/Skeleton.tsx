import { cn } from "@/lib/cn";

/* Shimmer skeleton — replaces "Loading…" text in async lists.
 * Uses the existing animate-shimmer keyframe defined in
 * desktop/src/index.css so the visual cue is shared across the
 * app. Three rows by default; pass `rows` to tune. */

export function SkeletonRows({ rows = 3, height = 12, className }: {
  rows?: number;
  height?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(className)}
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 14px" }}
      aria-busy="true"
      aria-live="polite"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="animate-shimmer"
          style={{
            height,
            width: `${85 - i * 7}%`,
            borderRadius: 4,
            opacity: 1 - i * 0.12,
          }}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn(className)} style={{
      padding: 14,
      border: "1px solid var(--color-border)",
      borderRadius: "var(--radius-proto, 6px)",
      background: "var(--color-bg-elevated)",
      display: "flex",
      flexDirection: "column",
      gap: 10,
    }} aria-busy="true">
      <div className="animate-shimmer" style={{ height: 14, width: "40%", borderRadius: 4 }} />
      <div className="animate-shimmer" style={{ height: 11, width: "85%", borderRadius: 4, opacity: 0.85 }} />
      <div className="animate-shimmer" style={{ height: 11, width: "70%", borderRadius: 4, opacity: 0.7 }} />
    </div>
  );
}
