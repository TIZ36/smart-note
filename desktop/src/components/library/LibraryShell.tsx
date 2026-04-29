import { cn } from "@/lib/cn";
import type { ChannelId } from "@/lib/types";
import { LibraryDocsPane } from "./LibraryDocsPane";
import { LibraryMemoriesPane } from "./LibraryMemoriesPane";
import { LibrarySkillsPane } from "./LibrarySkillsPane";

/* Library surface — three sub-tabs share left-tree + right-pane chrome.
 *
 *   Docs       wiki documents grouped by AI topic (default)
 *   Memories   agent-proposed (MCP) + daily-digest candidates
 *   Skills     claude/cursor/opencode skill files + workflows
 *
 * Active sub-tab is driven by the routed channel (library:docs |
 * library:memories | library:skills). Pending memory count shows
 * as the "· N pending" accent on the Memories tab.
 */

type SubTab = "docs" | "memories" | "skills";

type Props = {
  active: SubTab;
  onSelect: (channel: ChannelId) => void;
  pendingMemoryCount: number;
  memoryCount?: number;
  docsCount?: number;
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
        {active === "docs" && <LibraryDocsPane onOpenSource={onSelect} />}
        {active === "memories" && <LibraryMemoriesPane />}
        {active === "skills" && <LibrarySkillsPane />}
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
