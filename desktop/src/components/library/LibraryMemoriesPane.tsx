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

export function LibraryMemoriesPane() {
  const [proposals, setProposals] = useState<cloudApi.Proposal[] | null>(null);
  const [active, setActive] = useState<string>("pending"); // bucket key
  const [groupMode, setGroupMode] = useState<GroupMode>("source");
  const [filter, setFilter] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
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
    load();
    const id = setInterval(load, 30_000);
    return () => { clearInterval(id); };
  }, []);

  // Buckets for the left tree.
  const buckets = useMemo(() => {
    if (!proposals) return [];
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? proposals.filter((p) => p.content.toLowerCase().includes(q))
      : proposals;

    type Bucket = { key: string; label: string; group: string; items: cloudApi.Proposal[] };
    const result: Bucket[] = [];

    // Always show "All pending" at top
    result.push({ key: "pending", label: "All pending", group: "Pending review", items: filtered });

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

  const activeBucket = buckets.find((b) => b.key === active) || buckets[0];

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
          <input
            className="proto-library-tree-search"
            placeholder="Filter memories…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="proto-library-tree-mode" role="tablist" aria-label="Group mode">
            <button
              type="button"
              aria-pressed={groupMode === "source"}
              title="By source agent"
              onClick={() => setGroupMode("source")}
            >
              Source
            </button>
            <button
              type="button"
              aria-pressed={groupMode === "kind"}
              title="By kind"
              onClick={() => setGroupMode("kind")}
            >
              Kind
            </button>
          </span>
        </div>
        <div className="proto-library-tree-scroll">
          {proposals === null && (
            <div style={{ padding: 12, fontSize: 11, color: "var(--color-text-muted)" }}>
              loading…
            </div>
          )}
          {proposals !== null && proposals.length === 0 && (
            <div style={{ padding: 12, fontSize: 11, color: "var(--color-text-muted)" }}>
              No pending memories. Cursor and Claude Code will surface drafts here as they work.
            </div>
          )}

          {/* Pending review group at top */}
          {buckets.length > 0 && (
            <>
              <div className="proto-library-group">
                <span>Pending review</span>
                <span className="proto-library-group-count">{proposals?.length ?? 0}</span>
              </div>
              {buckets
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
                    <span className="proto-library-tree-item-count">{b.items.length}</span>
                  </button>
                ))}
            </>
          )}

          {/* By-source / by-kind buckets */}
          {(() => {
            const groups = new Map<string, typeof buckets>();
            for (const b of buckets.filter((x) => x.key !== "pending")) {
              const arr = groups.get(b.group) || [];
              arr.push(b);
              groups.set(b.group, arr);
            }
            return Array.from(groups.entries()).map(([groupName, items]) => (
              <div key={groupName}>
                <div className="proto-library-group">
                  <span>{groupName}</span>
                  <span className="proto-library-group-count">
                    {items.reduce((n, i) => n + i.items.length, 0)}
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
                    <span className="proto-library-tree-item-count">{b.items.length}</span>
                  </button>
                ))}
              </div>
            ));
          })()}
        </div>
      </aside>

      {/* Right content */}
      <div className="proto-library-content">
        <div className="proto-library-content-bar">
          <div className="proto-library-content-title">
            {activeBucket?.label || "Memories"}
          </div>
          <div className="proto-library-content-meta">
            {activeBucket?.items.length ?? 0} item
            {(activeBucket?.items.length ?? 0) === 1 ? "" : "s"}
          </div>
          <div className="proto-library-content-actions">
            <button type="button" className="proto-library-btn" title="Run today's digest">
              Run digest now
            </button>
            <button type="button" className="proto-library-btn">Accept all</button>
          </div>
        </div>

        <div className="proto-library-content-scroll">
          {!activeBucket || activeBucket.items.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", padding: 24 }}>
              No memories in this bucket yet.
            </div>
          ) : (
            <div className="proto-library-card-list">
              {activeBucket.items.map((p) => (
                <div
                  key={p.id}
                  className="proto-memory-card"
                  data-pending="true"
                >
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
                    <button type="button" className="proto-row-action">Edit</button>
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
