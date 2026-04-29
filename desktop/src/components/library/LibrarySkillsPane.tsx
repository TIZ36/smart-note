import { useMemo, useState } from "react";

/* Library · Skills pane.
 *
 * Phase 1+ stub-real: shows the canonical agent skills shipped with
 * SmartNote (claude-skill, cursor-skill, opencode-skill) plus a slot
 * for "Custom workflows". Phase 4 wires the real /v1/skills endpoint
 * that reads invocation counts + arbitrary user-defined skills.
 */

type Agent = "Claude Code" | "Cursor" | "Opencode" | "Custom workflows";

type Skill = {
  name: string;
  agent: Agent;
  trigger: string;
  description: string;
  tags: string[];
  invocations?: number;
  lastUsed?: string;
};

const CORE_SKILLS: Skill[] = [
  {
    name: "claude-skill",
    agent: "Claude Code",
    trigger: "on agent boot",
    description:
      "Loaded into Claude Code on session start. Tells the agent how to use SmartNote MCP — search_memory, propose_memory, queue_enrich_jobs — and when to read vs. write.",
    tags: ["claude-code", "mcp", "core"],
  },
  {
    name: "cursor-skill",
    agent: "Cursor",
    trigger: "on agent boot",
    description:
      "Cursor variant of SmartNote integration. Same MCP surface, slightly different prompt for Cursor's editor-agent context.",
    tags: ["cursor", "mcp"],
  },
  {
    name: "opencode-skill",
    agent: "Opencode",
    trigger: "on agent boot",
    description:
      "Opencode integration. Lower invocation rate — keep around for cross-agent compatibility.",
    tags: ["opencode", "mcp"],
  },
];

export function LibrarySkillsPane() {
  const [filter, setFilter] = useState("");
  const [activeAgent, setActiveAgent] = useState<Agent | "all">("all");

  const filtered = useMemo(() => {
    let s = CORE_SKILLS;
    if (activeAgent !== "all") s = s.filter((x) => x.agent === activeAgent);
    if (filter.trim()) {
      const q = filter.toLowerCase();
      s = s.filter(
        (x) =>
          x.name.toLowerCase().includes(q) ||
          x.description.toLowerCase().includes(q),
      );
    }
    return s;
  }, [filter, activeAgent]);

  const byAgent = useMemo(() => {
    const map = new Map<Agent, Skill[]>();
    for (const s of CORE_SKILLS) {
      const arr = map.get(s.agent) || [];
      arr.push(s);
      map.set(s.agent, arr);
    }
    return map;
  }, []);

  return (
    <div className="proto-library-pane-cols">
      {/* Left tree by agent */}
      <aside className="proto-library-tree">
        <div className="proto-library-tree-bar">
          <input
            className="proto-library-tree-search"
            placeholder="Filter skills…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="proto-library-tree-mode" role="tablist" aria-label="Group mode">
            <button type="button" aria-pressed>Agent</button>
            <button type="button" aria-pressed={false}>Use</button>
          </span>
        </div>
        <div className="proto-library-tree-scroll">
          <div className="proto-library-group">
            <span>All skills</span>
            <span className="proto-library-group-count">{CORE_SKILLS.length}</span>
          </div>
          <button
            type="button"
            className="proto-library-tree-item"
            aria-current={activeAgent === "all"}
            onClick={() => setActiveAgent("all")}
          >
            <span className="proto-library-tree-item-name">All</span>
            <span className="proto-library-tree-item-count">{CORE_SKILLS.length}</span>
          </button>

          {Array.from(byAgent.entries()).map(([agent, skills]) => (
            <div key={agent}>
              <div className="proto-library-group">
                <span>{agent}</span>
                <span className="proto-library-group-count">{skills.length}</span>
              </div>
              {skills.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  className="proto-library-tree-item"
                  aria-current={activeAgent === agent}
                  onClick={() => setActiveAgent(agent)}
                >
                  <span className="proto-library-tree-item-name">{s.name}</span>
                  <span className="proto-library-tree-item-count">
                    {s.invocations ?? "—"}
                  </span>
                </button>
              ))}
            </div>
          ))}

          <div className="proto-library-group">
            <span>Custom workflows</span>
            <span className="proto-library-group-count">0</span>
          </div>
          <div
            style={{
              padding: "5px 12px",
              fontSize: 11,
              color: "var(--color-text-muted)",
              fontStyle: "italic",
            }}
          >
            None yet — Phase 4 wires up workflow registration.
          </div>
        </div>
      </aside>

      {/* Right cards */}
      <div className="proto-library-content">
        <div className="proto-library-content-bar">
          <div className="proto-library-content-title">
            {activeAgent === "all"
              ? "All skills · invoked by AI CLIs through MCP"
              : `${activeAgent} · skills`}
          </div>
          <div className="proto-library-content-meta">
            {filtered.length} skill{filtered.length === 1 ? "" : "s"}
          </div>
          <div className="proto-library-content-actions">
            <button type="button" className="proto-library-btn">+ New skill</button>
            <button type="button" className="proto-library-btn">Open in editor</button>
          </div>
        </div>

        <div className="proto-library-content-scroll">
          <div className="proto-library-card-list">
            {filtered.map((s) => (
              <div key={s.name} className="proto-skill-card">
                <div className="proto-skill-card-head">
                  <div className="proto-skill-card-name">{s.name}</div>
                  <span className="proto-skill-card-trigger">{s.trigger}</span>
                  <span className="proto-skill-card-meta">
                    {s.invocations !== undefined
                      ? `${s.invocations} calls`
                      : "no telemetry yet"}
                    {s.lastUsed && ` · ${s.lastUsed}`}
                  </span>
                </div>
                <div className="proto-skill-card-desc">{s.description}</div>
                <div className="proto-skill-card-tags">
                  {s.tags.map((t, i) => (
                    <span
                      key={i}
                      className={i === 0 ? "proto-tag proto-tag-accent" : "proto-tag"}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
