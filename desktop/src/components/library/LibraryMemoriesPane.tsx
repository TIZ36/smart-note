import { useEffect, useMemo, useState } from "react";
import * as cloudApi from "@/lib/cloud-api";

/* Library · Memories pane.
 *
 * Two propose entry-points (per the v3 design): AI CLIs via MCP
 * `propose_memory`, and the daily digest synthesizer that runs
 * over today's stream. Both surface here with Accept / Edit /
 * Reject. Left tree groups proposals by source agent + by-day
 * digest buckets.
 */

type GroupMode = "source" | "kind";
type ViewMode = "pending" | "saved";

export function LibraryMemoriesPane() {
  const [proposals, setProposals] = useState<cloudApi.Proposal[] | null>(null);
  // Committed memories — populated only when the user is on the
  // Saved tab. Memories added via MCP `add_memory` / `set_preference`
  // skip proposals entirely; without this view, the user thinks
  // "I added it but it didn't show up". The two views share filter /
  // groupMode so the left tree behaves the same.
  const [memories, setMemories] = useState<cloudApi.Memory[] | null>(null);
  const [view, setView] = useState<ViewMode>("pending");
  const [active, setActive] = useState<string>("pending"); // bucket key
  const [groupMode, setGroupMode] = useState<GroupMode>("source");
  const [filter, setFilter] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function loadProposals() {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) setProposals([]);
          return;
        }
        const res = await cloudApi.listProposals(100);
        if (alive) setProposals(res.proposals);
      } catch {
        if (alive) setProposals([]);
      }
    }
    loadProposals();
    const id = setInterval(loadProposals, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Saved memories load lazily — only when the user flips to that
  // tab. Keeps the initial pane render cheap when the user just
  // wants to triage proposals. Refresh on a 30s tick too so MCP
  // writes show up without needing a manual reload.
  useEffect(() => {
    if (view !== "saved") return;
    let alive = true;
    async function loadMemories() {
      try {
        if (!(await cloudApi.isCloudConfigured())) {
          if (alive) setMemories([]);
          return;
        }
        const res = await cloudApi.listMemories({ limit: 500 });
        if (alive) setMemories(res.memories);
      } catch {
        if (alive) setMemories([]);
      }
    }
    loadMemories();
    const id = setInterval(loadMemories, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [view]);

  // Buckets for the left tree.
  const buckets = useMemo(() => {
    if (!proposals) return [];
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? proposals.filter((p) => p.content.toLowerCase().includes(q))
      : proposals;

    type Bucket = { key: string; label: string; group: string; items: cloudApi.Proposal[] };
    const result: Bucket[] = [];

    // Always show "All proposals" at top
    result.push({ key: "pending", label: "All proposals", group: "Proposals", items: filtered });

    if (groupMode === "source") {
      const bySource = new Map<string, cloudApi.Proposal[]>();
      for (const p of filtered) {
        const src = sourceLabel(p);
        const arr = bySource.get(src) || [];
        arr.push(p);
        bySource.set(src, arr);
      }
      for (const [src, items] of bySource) {
        result.push({ key: `src:${src}`, label: src, group: `From ${src}`, items });
      }
    } else {
      // kind = group by author_kind / kind metadata if present
      const byKind = new Map<string, cloudApi.Proposal[]>();
      for (const p of filtered) {
        const k = p.kind || "fact";
        const arr = byKind.get(k) || [];
        arr.push(p);
        byKind.set(k, arr);
      }
      for (const [k, items] of byKind) {
        result.push({ key: `kind:${k}`, label: k, group: `By kind: ${k}`, items });
      }
    }

    return result;
  }, [proposals, groupMode, filter]);

  // Saved-view buckets — same shape as proposals buckets so the
  // existing tree + content rendering can switch on `view` without
  // a fork. Discriminator on the item type means cards can render
  // pending vs saved differently below.
  const savedBuckets = useMemo(() => {
    if (!memories) return [];
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? memories.filter((m) => m.content.toLowerCase().includes(q))
      : memories;
    type SBucket = { key: string; label: string; group: string; items: cloudApi.Memory[] };
    const result: SBucket[] = [];
    result.push({ key: "pending", label: "All memories", group: "Saved", items: filtered });
    if (groupMode === "source") {
      const m = new Map<string, cloudApi.Memory[]>();
      for (const x of filtered) {
        const a = x.author_agent || "unknown";
        const arr = m.get(a) || [];
        arr.push(x); m.set(a, arr);
      }
      for (const [src, items] of m) {
        result.push({ key: `src:${src}`, label: src, group: `From ${src}`, items });
      }
    } else {
      const m = new Map<string, cloudApi.Memory[]>();
      for (const x of filtered) {
        const arr = m.get(x.kind) || [];
        arr.push(x); m.set(x.kind, arr);
      }
      for (const [k, items] of m) {
        result.push({ key: `kind:${k}`, label: k, group: `By kind: ${k}`, items });
      }
    }
    return result;
  }, [memories, groupMode, filter]);

  // Active view's bucket list — proposals shape vs memories shape
  // are isomorphic enough at this level (key/label/group/items
  // count) that the tree renders both.
  const treeBuckets = view === "pending"
    ? buckets.map((b) => ({ key: b.key, label: b.label, group: b.group, count: b.items.length }))
    : savedBuckets.map((b) => ({ key: b.key, label: b.label, group: b.group, count: b.items.length }));

  const activeBucket = buckets.find((b) => b.key === active) || buckets[0];
  const activeSavedBucket = savedBuckets.find((b) => b.key === active) || savedBuckets[0];

  async function handleAccept(p: cloudApi.Proposal) {
    setBusyId(p.id);
    try {
      await cloudApi.acceptProposal(p.id);
      setProposals((cur) => cur && cur.filter((x) => x.id !== p.id));
    } catch {
      /* silent — the user will see it didn't disappear */
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(p: cloudApi.Proposal) {
    setBusyId(p.id);
    try {
      await cloudApi.rejectProposal(p.id);
      setProposals((cur) => cur && cur.filter((x) => x.id !== p.id));
    } catch {
      /* silent */
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="proto-library-pane-cols">
      {/* Left tree */}
      <aside className="proto-library-tree">
        <div className="proto-library-tree-bar">
          {/* View switcher — Pending review (proposals queue) vs
              Saved (committed memories table). MCP add_memory /
              set_preference land in Saved, propose_memory lands
              in Pending. */}
          <div className="proto-library-tree-view-switch" role="group" aria-label="Memory view">
            <button
              type="button"
              aria-pressed={view === "pending"}
              onClick={() => { setView("pending"); setActive("pending"); }}
            >
              Proposals
              <span className="proto-library-tree-view-switch-count">
                {proposals?.length ?? 0}
              </span>
            </button>
            <button
              type="button"
              aria-pressed={view === "saved"}
              onClick={() => { setView("saved"); setActive("pending"); }}
            >
              Saved
              {memories !== null && (
                <span className="proto-library-tree-view-switch-count">{memories.length}</span>
              )}
            </button>
          </div>
          <input
            className="proto-library-tree-search"
            placeholder={view === "pending" ? "Filter proposals…" : "Filter memories…"}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="proto-library-tree-mode" role="group" aria-label="Group mode">
            <button
              type="button"
              aria-pressed={groupMode === "source"}
              title="Group by source agent"
              onClick={() => setGroupMode("source")}
            >
              Source
            </button>
            <button
              type="button"
              aria-pressed={groupMode === "kind"}
              title="Group by kind"
              onClick={() => setGroupMode("kind")}
            >
              Kind
            </button>
          </div>
        </div>
        <div className="proto-library-tree-scroll">
          {view === "pending" && proposals === null && (
            <div className="proto-library-tree-status">Loading proposals…</div>
          )}
          {view === "pending" && proposals !== null && proposals.length === 0 && (
            <div className="proto-library-tree-status">
              No proposals yet. Cursor and Claude Code surface drafts here as they work.
            </div>
          )}
          {view === "saved" && memories === null && (
            <div className="proto-library-tree-status">Loading memories…</div>
          )}
          {view === "saved" && memories !== null && memories.length === 0 && (
            <div className="proto-library-tree-status">
              No saved memories yet. Use MCP <code>add_memory</code> or <code>set_preference</code>.
            </div>
          )}

          {/* "All" bucket at top — pending or saved depending on view */}
          {treeBuckets.length > 0 && (
            <>
              <div className="proto-library-group">
                <span>{view === "pending" ? "Pending review" : "Saved memories"}</span>
                <span className="proto-library-group-count">
                  {view === "pending" ? (proposals?.length ?? 0) : (memories?.length ?? 0)}
                </span>
              </div>
              {treeBuckets
                .filter((b) => b.key === "pending")
                .map((b) => (
                  <button
                    type="button"
                    key={b.key}
                    className="proto-library-tree-item"
                    aria-current={b.key === active}
                    onClick={() => setActive(b.key)}
                  >
                    <span className="proto-library-tree-item-name">{b.label}</span>
                    <span className="proto-library-tree-item-count">{b.count}</span>
                  </button>
                ))}
            </>
          )}

          {/* By-source / by-kind buckets */}
          {(() => {
            const groups = new Map<string, typeof treeBuckets>();
            for (const b of treeBuckets.filter((x) => x.key !== "pending")) {
              const arr = groups.get(b.group) || [];
              arr.push(b);
              groups.set(b.group, arr);
            }
            return Array.from(groups.entries()).map(([groupName, items]) => (
              <div key={groupName}>
                <div className="proto-library-group">
                  <span>{groupName}</span>
                  <span className="proto-library-group-count">
                    {items.reduce((n, i) => n + i.count, 0)}
                  </span>
                </div>
                {items.map((b) => (
                  <button
                    type="button"
                    key={b.key}
                    className="proto-library-tree-item"
                    aria-current={b.key === active}
                    onClick={() => setActive(b.key)}
                  >
                    <span className="proto-library-tree-item-name">{b.label}</span>
                    <span className="proto-library-tree-item-count">{b.count}</span>
                  </button>
                ))}
              </div>
            ));
          })()}
        </div>
      </aside>

      {/* Right content — split into Pending vs Saved render paths
          because the action affordances differ (Accept/Reject for
          proposals, plain display for committed memories). */}
      <div className="proto-library-content">
        {view === "pending" ? (
          <>
            <div className="proto-library-content-bar">
              <div className="proto-library-content-title">
                {activeBucket?.label || "Memories"}
              </div>
              <div className="proto-library-content-meta">
                {activeBucket?.items.length ?? 0} item
                {(activeBucket?.items.length ?? 0) === 1 ? "" : "s"}
              </div>
              {/* Bulk affordances (Run digest / Accept all) intentionally
                  deferred until the backend exposes batch endpoints — a
                  disabled-looking enabled button is the worst state. */}
              <div className="proto-library-content-actions" />
            </div>
            <div className="proto-library-content-scroll">
              {!activeBucket || activeBucket.items.length === 0 ? (
                <div className="proto-library-content-empty">
                  Nothing here yet.
                </div>
              ) : (
                <div className="proto-library-card-list">
                  {activeBucket.items.map((p) => (
                    <div key={p.id} className="proto-memory-card" data-pending="true">
                      <div className="proto-memory-quote">{p.content}</div>
                      <div className="proto-memory-source">
                        <span className="proto-memory-source-agent">{sourceLabel(p)}</span>
                        {p.proposal_reason && (
                          <>
                            <span>·</span>
                            <span className="proto-memory-source-conv">{p.proposal_reason}</span>
                          </>
                        )}
                        {typeof p.confidence === "number" && (
                          <>
                            <span>·</span>
                            <span>{p.confidence.toFixed(2)} confidence</span>
                          </>
                        )}
                        <span>·</span>
                        <span>{relTime(p.created_at)}</span>
                      </div>
                      <div className="proto-memory-card-actions">
                        <button
                          type="button"
                          className="proto-row-action proto-row-action-accept"
                          disabled={busyId === p.id}
                          onClick={() => handleAccept(p)}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="proto-row-action"
                          disabled={busyId === p.id}
                          onClick={() => handleReject(p)}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="proto-library-content-bar">
              <div className="proto-library-content-title">
                {activeSavedBucket?.label || "Saved memories"}
              </div>
              <div className="proto-library-content-meta">
                {activeSavedBucket?.items.length ?? 0} item
                {(activeSavedBucket?.items.length ?? 0) === 1 ? "" : "s"}
              </div>
            </div>
            <div className="proto-library-content-scroll">
              {!activeSavedBucket || activeSavedBucket.items.length === 0 ? (
                <div className="proto-library-content-empty">
                  Nothing here yet.
                </div>
              ) : (
                <div className="proto-library-card-list">
                  {activeSavedBucket.items.map((m) => (
                    <div key={m.id} className="proto-memory-card">
                      <div className="proto-memory-quote">
                        {m.pinned && <span className="proto-memory-pin" aria-label="Pinned" title="Pinned">★</span>}
                        {m.content}
                      </div>
                      <div className="proto-memory-source">
                        <span className="proto-memory-source-agent">{m.author_agent || "Unknown agent"}</span>
                        <span>·</span>
                        <span>{m.kind}</span>
                        {m.scope && m.scope !== "global" && (
                          <>
                            <span>·</span>
                            <span>{m.scope}</span>
                          </>
                        )}
                        {m.tags && m.tags.length > 0 && (
                          <>
                            <span>·</span>
                            <span>{m.tags.join(", ")}</span>
                          </>
                        )}
                        <span>·</span>
                        <span>{relTime(m.created_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function sourceLabel(p: cloudApi.Proposal): string {
  // Daily-digest proposals will tag author_agent="digest" once that
  // backend lands. For now, the propose_memory MCP tool fills
  // author_agent with the calling agent's name (e.g. "claude-code").
  if (!p.author_agent) return "unknown";
  if (p.author_agent === "digest") return "Daily digest";
  if (p.author_agent === "user") return "You";
  return p.author_agent;
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}
