import { cn } from "@/lib/cn";
import type { ChannelId } from "@/lib/types";

/* Library surface (replaces v2's "Wiki" rail destination).
 *
 * Three sub-tabs share a left-tree + right-content chrome:
 *
 *   Docs       — wiki documents grouped by AI topic (default)
 *   Memories   — agent-proposed (MCP) + daily-digest candidates
 *   Skills     — claude/cursor/opencode skill files + custom workflows
 *
 * Phase 1 stub: tabs render and sync to the active channel; pane
 * bodies land in Phase 3 (Docs + Memories) and Phase 4 (Skills).
 */

type SubTab = "docs" | "memories" | "skills";

type Props = {
  /** Which sub-tab is active. Driven by the routed channel. */
  active: SubTab;
  onSelect: (channel: ChannelId) => void;
  /** Pending memory count (drives the "· N pending" accent on Memories). */
  pendingMemoryCount: number;
  /** Total memory count for the count badge. */
  memoryCount?: number;
  /** Total docs count for the count badge. */
  docsCount?: number;
  /** Total skills count for the count badge. */
  skillsCount?: number;
};

export function LibraryShell({
  active,
  onSelect,
  pendingMemoryCount,
  memoryCount,
  docsCount,
  skillsCount,
}: Props) {
  return (
    <div className="proto-library-shell">
      <nav
        className="proto-library-tabs"
        role="tablist"
        aria-label="Library kind"
      >
        <Tab
          active={active === "docs"}
          onClick={() => onSelect("library:docs")}
          label="Docs"
          count={docsCount}
        />
        <Tab
          active={active === "memories"}
          onClick={() => onSelect("library:memories")}
          label="Memories"
          count={memoryCount}
          pending={pendingMemoryCount > 0 ? pendingMemoryCount : undefined}
        />
        <Tab
          active={active === "skills"}
          onClick={() => onSelect("library:skills")}
          label="Skills"
          count={skillsCount}
        />
      </nav>

      <div className="proto-library-pane" role="tabpanel">
        <div className="proto-library-empty">
          {active === "docs" && "Docs pane lands in Phase 3 — wiki topic tree + chunks viewer."}
          {active === "memories" && "Memories pane lands in Phase 3 — pending review + daily digest + by-source groups."}
          {active === "skills" && "Skills pane lands in Phase 4 — by-agent grouping + skill markdown cards."}
        </div>
      </div>
    </div>
  );
}

function Tab({
  active,
  onClick,
  label,
  count,
  pending,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  pending?: number;
}) {
  return (
    <button
      type="button"
      className={cn("proto-library-tab")}
      aria-pressed={active}
      role="tab"
      onClick={onClick}
    >
      {label}
      {count !== undefined && (
        <span className="proto-library-tab-count">{count}</span>
      )}
      {pending !== undefined && (
        <span className="proto-library-tab-pending">· {pending} pending</span>
      )}
    </button>
  );
}
