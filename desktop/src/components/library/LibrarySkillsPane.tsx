import { useEffect, useMemo, useState } from "react";
import * as cloudApi from "@/lib/cloud-api";

/* Library · Skills pane.
 *
 * Reads real cloud documents where `metadata.smartnote_type === "skill"`
 * — these are agent recipes / workflow specs uploaded via MCP
 * `add_document(smartnote_type="skill")` or hand-classified.
 *
 * Previously this pane rendered a hardcoded fake list (claude-skill /
 * cursor-skill / opencode-skill) which never reflected what the user
 * actually uploaded — so a real skill landing in cloud was invisible.
 *
 * Phase-1 layout: left tree groups skills by inferred agent (parsed
 * from the filename — `skill_claude-xxx.md` → "Claude Code"); right
 * pane shows skill cards with a content preview. Click a card to
 * open the doc via the Source channel for full read / edit.
 */

type Agent = "Claude Code" | "Cursor" | "Opencode" | "Other";

function inferAgent(name: string): Agent {
  const lower = name.toLowerCase();
  if (lower.includes("claude") || lower.includes("cc-")) return "Claude Code";
  if (lower.includes("cursor")) return "Cursor";
  if (lower.includes("opencode")) return "Opencode";
  return "Other";
}

function prettyName(name: string): string {
  // `skill_dap-callback-developer.md` → `dap-callback-developer`
  let n = name.replace(/^skill[_-]?/i, "");
  n = n.replace(/\.(md|markdown|txt)$/i, "");
  return n || name;
}

function firstParagraph(content: string | undefined | null, maxLen = 240): string {
  if (!content) return "";
  // Trim leading blank lines, take until the first double-newline.
  const trimmed = content.replace(/^\s+/, "");
  const p = trimmed.split(/\n\s*\n/, 1)[0] || trimmed;
  const cleaned = p.replace(/^#+\s+/, "").replace(/\s+/g, " ");
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + "…";
}

export function LibrarySkillsPane() {
  const [skills, setSkills] = useState<cloudApi.CloudDocument[] | null>(null);
  const [filter, setFilter] = useState("");
  const [activeAgent, setActiveAgent] = useState<Agent | "all">("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [body, setBody] = useState<string>("");
  const [bodyLoading, setBodyLoading] = useState(false);

  // Cloud fetch: list all docs with smartnote_type=skill. Refresh on
  // a 30s cadence so MCP uploads (which don't ping the desktop) show
  // up without manual reload.
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) setSkills([]);
          return;
        }
        const res = await cloudApi.listDocuments({ smartnote_type: "skill" });
        if (alive) setSkills(res.documents);
      } catch {
        if (alive) setSkills([]);
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Auto-select first skill so the right pane isn't empty.
  useEffect(() => {
    if (!skills || skills.length === 0) { setActiveId(null); return; }
    if (!activeId || !skills.find((s) => s.id === activeId)) {
      setActiveId(skills[0].id);
    }
  }, [skills]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch full body of the active skill so the right pane previews
  // the actual content, not just the listing-row preview.
  useEffect(() => {
    if (!activeId) { setBody(""); return; }
    let alive = true;
    setBodyLoading(true);
    cloudApi.getDocument(activeId)
      .then((d) => { if (alive) { setBody(d.content || ""); setBodyLoading(false); } })
      .catch(() => { if (alive) { setBody(""); setBodyLoading(false); } });
    return () => { alive = false; };
  }, [activeId]);

  const filtered = useMemo(() => {
    if (!skills) return [];
    let s = skills;
    if (activeAgent !== "all") s = s.filter((d) => inferAgent(d.name) === activeAgent);
    if (filter.trim()) {
      const q = filter.toLowerCase();
      s = s.filter((d) => d.name.toLowerCase().includes(q));
    }
    return s;
  }, [skills, filter, activeAgent]);

  const byAgent = useMemo(() => {
    const map = new Map<Agent, cloudApi.CloudDocument[]>();
    if (!skills) return map;
    for (const d of skills) {
      const a = inferAgent(d.name);
      const arr = map.get(a) || [];
      arr.push(d);
      map.set(a, arr);
    }
    return map;
  }, [skills]);

  const active = filtered.find((s) => s.id === activeId) || filtered[0] || null;

  return (
    <div className="proto-library-pane-cols">
      <aside className="proto-library-tree">
        <div className="proto-library-tree-bar">
          <input
            className="proto-library-tree-search"
            placeholder="Filter skills…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="proto-library-tree-scroll">
          {skills === null && (
            <div style={{ padding: 12, fontSize: 11, color: "var(--color-text-muted)" }}>
              loading…
            </div>
          )}
          {skills !== null && skills.length === 0 && (
            <div style={{ padding: 12, fontSize: 11, color: "var(--color-text-muted)" }}>
              No skills yet. Upload via MCP <code>add_document(name="skill_…", smartnote_type="skill")</code>.
            </div>
          )}

          {skills && skills.length > 0 && (
            <>
              <div className="proto-library-group">
                <span>All skills</span>
                <span className="proto-library-group-count">{skills.length}</span>
              </div>
              <button
                type="button"
                className="proto-library-tree-item"
                aria-current={activeAgent === "all"}
                onClick={() => setActiveAgent("all")}
              >
                <span className="proto-library-tree-item-name">All</span>
                <span className="proto-library-tree-item-count">{skills.length}</span>
              </button>

              {Array.from(byAgent.entries()).map(([agent, list]) => (
                <div key={agent}>
                  <div className="proto-library-group">
                    <span>{agent}</span>
                    <span className="proto-library-group-count">{list.length}</span>
                  </div>
                  {list.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className="proto-library-tree-item"
                      aria-current={d.id === activeId}
                      onClick={() => { setActiveId(d.id); setActiveAgent(agent); }}
                      title={d.name}
                    >
                      <span className="proto-library-tree-item-name">{prettyName(d.name)}</span>
                      <span className="proto-library-tree-item-count">
                        {Math.round((d.byte_size ?? 0) / 1024)}k
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      </aside>

      <div className="proto-library-content">
        <div className="proto-library-content-bar">
          <div className="proto-library-content-title">
            {active ? prettyName(active.name) : "Skills"}
          </div>
          <div className="proto-library-content-meta">
            {active
              ? `${inferAgent(active.name)} · ${Math.round((active.byte_size ?? 0) / 1024)}k`
              : `${filtered.length} skill${filtered.length === 1 ? "" : "s"}`}
          </div>
        </div>

        <div className="proto-library-content-scroll">
          {!active && (
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", padding: 24 }}>
              {skills === null ? "loading…" : "No skill selected. Upload one via MCP or pick one from the left."}
            </div>
          )}
          {active && (
            <div className="proto-library-card-list">
              <div className="proto-skill-card">
                <div className="proto-skill-card-head">
                  <div className="proto-skill-card-name">{prettyName(active.name)}</div>
                  <span className="proto-skill-card-trigger">{inferAgent(active.name)}</span>
                  <span className="proto-skill-card-meta">
                    {Math.round((active.byte_size ?? 0) / 1024)}k · added {new Date(active.created_at).toLocaleDateString()}
                  </span>
                </div>
                <div className="proto-skill-card-desc">
                  {bodyLoading ? "loading…" : firstParagraph(body, 360)}
                </div>
                {/* Full content preview — monospace, scrollable.
                    Caps at 2k chars so the pane stays browsable; click
                    "Open in editor" for the full file. */}
                <pre style={{
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  padding: "12px 14px",
                  marginTop: 10,
                  border: "1px solid var(--color-border)",
                  borderRadius: 4,
                  background: "var(--color-bg-soft, var(--color-bg-elevated))",
                  color: "var(--color-text-secondary)",
                  maxHeight: 480,
                  overflow: "auto",
                }}>
                  {bodyLoading ? "loading…" : (body.slice(0, 4000) + (body.length > 4000 ? "\n\n…truncated" : ""))}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
