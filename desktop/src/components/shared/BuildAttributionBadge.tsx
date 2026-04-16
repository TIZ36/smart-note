type Props = {
  enrichStatus: string;
  completedBy: string;
  awaitingForSeconds: number | null;
};

/**
 * Small metadata badge rendered alongside a build ID. Communicates:
 *   - `awaiting` / `awaiting Xm`       — backend is waiting for MCP enrich
 *   - `stuck Xm`                       — awaiting too long (>= 30 min)
 *   - `by claude`                      — enriched by the MCP delegate
 *   - `inherited`                      — auto-inherited via hash/centroid
 *   - `by <model>`                     — enriched by a provider LLM
 *   - `no ai`                          — AI disabled at ingest time
 *
 * Quiet hierarchy: only states that need user attention (awaiting, stuck)
 * get color; attribution is expressed with weight/opacity only.
 */
export function BuildAttributionBadge({ enrichStatus, completedBy, awaitingForSeconds }: Props) {
  if (enrichStatus === "awaiting_enrich") {
    const secs = awaitingForSeconds ?? 0;
    const stuck = secs >= 30 * 60;
    const minutes = Math.floor(secs / 60);
    const label = stuck
      ? `stuck ${minutes}m`
      : minutes >= 1
        ? `awaiting ${minutes}m`
        : "awaiting";
    return (
      <span
        className={`proto-build-badge ${stuck ? "proto-build-badge--stuck" : "proto-build-badge--awaiting"}`}
        aria-label={stuck ? `Stuck in awaiting enrich for ${minutes} minutes` : "Awaiting enrichment"}
      >
        {label}
      </span>
    );
  }
  if (completedBy === "mcp:delegate") {
    return (
      <span className="proto-build-badge proto-build-badge--attribution-prominent" aria-label="Enriched by Claude">
        by claude
      </span>
    );
  }
  if (completedBy === "mcp:auto_inherit") {
    return (
      <span className="proto-build-badge proto-build-badge--attribution" aria-label="Auto-inherited from similar chunks">
        inherited
      </span>
    );
  }
  if (completedBy.startsWith("provider:")) {
    const model = completedBy.slice("provider:".length);
    return (
      <span className="proto-build-badge proto-build-badge--attribution" aria-label={`Enriched by ${model}`}>
        by {model}
      </span>
    );
  }
  if (completedBy === "fallback") {
    return (
      <span className="proto-build-badge proto-build-badge--muted" aria-label="No AI enrichment">
        no ai
      </span>
    );
  }
  return null;
}
