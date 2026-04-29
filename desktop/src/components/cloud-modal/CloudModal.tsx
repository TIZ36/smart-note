import { useEffect, useState, type ReactNode } from "react";
import { X, Upload, Zap, Search, Calendar } from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { readSettings } from "@/lib/electron";

/* Cloud center modal (D3) — replaces v2's full-page CloudConsolePage.
 *
 * Lightweight: inventory + devices + plan + 4 quick actions
 * (Upload note → wiki, Trigger enrich, Run AI tag pass, Run today's
 * digest), auto-enrich toggle, MCP endpoint with copy.
 */

type Props = {
  open: boolean;
  onClose: () => void;
};

const REFRESH_MS = 6_000;

export function CloudModal({ open, onClose }: Props) {
  const [overview, setOverview] = useState<cloudApi.ConsoleOverview | null>(null);
  const [devices, setDevices] = useState<cloudApi.Device[] | null>(null);
  const [autoEnrich, setAutoEnrich] = useState(true);
  const [actionState, setActionState] = useState<Record<string, "idle" | "running" | "ok" | "err">>({});
  const [mcpUrl, setMcpUrl] = useState<string>("—");
  const [copied, setCopied] = useState(false);

  // Esc-to-close
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Fetch live data while open
  useEffect(() => {
    if (!open) return;
    let alive = true;
    async function refresh() {
      try {
        const ok = await cloudApi.isCloudConfigured();
        if (!ok || !alive) return;
        const [ov, devs] = await Promise.all([
          cloudApi.fetchOverview().catch(() => null),
          cloudApi.listDevices().catch(() => [] as cloudApi.Device[]),
        ]);
        if (!alive) return;
        if (ov) setOverview(ov);
        if (devs) setDevices(devs);
      } catch {
        /* silent */
      }
    }
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, [open]);

  // MCP endpoint = same base URL cloud-api uses, exposed so agent
  // CLIs (Claude Code / Cursor / Opencode) can paste it into their
  // MCP server config. Reads from persistent app settings — set in
  // Settings → SmartNote Cloud.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    readSettings().then((s) => {
      if (!alive) return;
      const url = (s.cloud_sync_url || "").trim();
      if (url) setMcpUrl(`${url.replace(/\/$/, "")}/mcp`);
      else setMcpUrl("—");
    }).catch(() => {
      if (alive) setMcpUrl("—");
    });
    return () => { alive = false; };
  }, [open]);

  if (!open) return null;

  function flashAction(id: string, state: "running" | "ok" | "err") {
    setActionState((s) => ({ ...s, [id]: state }));
    if (state !== "running") {
      setTimeout(() => setActionState((s) => ({ ...s, [id]: "idle" })), 1800);
    }
  }

  async function copyMcp() {
    if (mcpUrl === "—") return;
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* silent */
    }
  }

  // Action stubs — Phase 4 wires real endpoints (digest router, etc.)
  async function runAction(id: string) {
    flashAction(id, "running");
    try {
      // Most actions are stubs until backend lands. Trigger-enrich
      // could re-dispatch a known job, but for Phase 2 we just blink.
      await new Promise((r) => setTimeout(r, 400));
      flashAction(id, "ok");
    } catch {
      flashAction(id, "err");
    }
  }

  return (
    <div
      className="proto-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div
        className="proto-modal"
        role="dialog"
        aria-label="Workspace"
        aria-modal="true"
      >
        <div className="proto-modal-bar">
          <div className="proto-modal-title">Workspace</div>
          <div className="proto-modal-meta">
            {overview ? "live · refreshed" : "loading…"}
          </div>
          <button
            type="button"
            className="proto-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="proto-modal-body">

          {/* Inventory */}
          <div className="proto-modal-section">
            <div className="proto-modal-section-title">Inventory</div>
            <div className="proto-modal-stats">
              <Stat n={overview?.counts.documents ?? 0} l="documents" />
              <Stat n={overview?.counts.memories ?? 0} l="memories" />
              <Stat n={overview?.counts.enrich_done ?? 0} l="enriched" />
              <Stat
                n={overview?.counts.proposals_pending ?? 0}
                l="pending"
                accent={(overview?.counts.proposals_pending ?? 0) > 0}
              />
            </div>
          </div>

          {/* Devices + plan */}
          <div className="proto-modal-section">
            <div className="proto-modal-section-title">Devices · plan</div>
            {devices === null
              ? <div className="proto-modal-row-meta">loading…</div>
              : devices.length === 0
                ? <div className="proto-modal-row-meta">no devices paired yet</div>
                : devices.slice(0, 3).map((d) => (
                  <div key={d.id} className="proto-modal-row">
                    <span className="proto-modal-row-name">
                      {d.name || d.id.slice(0, 8)}
                      {d.is_primary && " · primary"}
                    </span>
                    <span className="proto-modal-row-meta">
                      {d.last_seen_at
                        ? `last seen ${relTime(d.last_seen_at)}`
                        : "—"}
                    </span>
                    <span
                      className={cn(
                        "proto-modal-pill",
                        d.online && "proto-modal-pill-success",
                        !d.online && "proto-modal-pill-warning",
                      )}
                    >
                      {d.online ? "online" : "offline"}
                    </span>
                  </div>
                ))}
          </div>

          {/* Quick actions */}
          <div className="proto-modal-section">
            <div className="proto-modal-section-title">Actions</div>
            <div className="proto-modal-actions-stack">
              <ActionButton
                icon={<Upload size={14} />}
                title="Upload note → wiki"
                help="Pick a note, classify into an AI topic, embed."
                state={actionState["upload"] || "idle"}
                onClick={() => runAction("upload")}
              />
              <ActionButton
                icon={<Zap size={14} />}
                title="Trigger enrich now"
                help="Re-classify everything pending · ~¥0.04 / 1k tokens."
                state={actionState["enrich"] || "idle"}
                onClick={() => runAction("enrich")}
              />
              <ActionButton
                icon={<Search size={14} />}
                title="Run AI tag pass"
                help="Generate / refresh tags across all chunks."
                state={actionState["tag"] || "idle"}
                onClick={() => runAction("tag")}
              />
              <ActionButton
                icon={<Calendar size={14} />}
                title="Run today's digest"
                help="Synthesize today's stream into candidate memories · auto-runs nightly."
                state={actionState["digest"] || "idle"}
                onClick={() => runAction("digest")}
              />
            </div>
          </div>

          {/* Auto-enrich toggle */}
          <div className="proto-modal-section">
            <div className="proto-modal-section-title">Auto-enrich</div>
            <div className="proto-modal-line">
              <button
                type="button"
                className="proto-toggle"
                aria-checked={autoEnrich}
                role="switch"
                onClick={() => setAutoEnrich((v) => !v)}
              />
              <span>Re-enrich on note edit · classifier + AI tags</span>
            </div>
            <div className="proto-modal-line-help">
              Runs in the background after every note save. Toggle off to throttle costs.
            </div>
          </div>

          {/* MCP endpoint — what AI CLIs (Claude / Cursor / Opencode)
              connect to via MCP to read + write your workspace. */}
          <div className="proto-modal-section">
            <div className="proto-modal-section-title">MCP endpoint for AI agents</div>
            {mcpUrl === "—" ? (
              <>
                <div className="proto-modal-mcp" style={{ color: "var(--color-text-muted)", fontStyle: "italic" }}>
                  <span className="proto-modal-mcp-text">
                    Cloud not configured — set URL + API key first.
                  </span>
                </div>
                <div className="proto-modal-line-help" style={{ paddingLeft: 0 }}>
                  Open <strong>Settings → SmartNote Cloud</strong> to add your
                  cloud URL and workspace API key. Once set, this endpoint
                  becomes the URL Claude Code / Cursor reads + writes through.
                </div>
              </>
            ) : (
              <>
                <div className="proto-modal-mcp">
                  <span className="proto-modal-mcp-text">{mcpUrl}</span>
                  <button
                    type="button"
                    className="proto-modal-mcp-copy"
                    onClick={copyMcp}
                  >
                    {copied ? "copied" : "copy"}
                  </button>
                </div>
                <div className="proto-modal-line-help" style={{ paddingLeft: 0 }}>
                  Paste this URL into Claude Code / Cursor MCP settings, then
                  add your workspace API key as the bearer token. Agents will
                  see the same memories, docs, and tags you do —
                  read + write — scoped to this workspace.
                </div>
              </>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

function Stat({ n, l, accent }: { n: number; l: string; accent?: boolean }) {
  return (
    <div>
      <div
        className="proto-modal-stat-num"
        style={accent ? { color: "var(--color-accent)" } : undefined}
      >
        {n.toLocaleString()}
      </div>
      <div className="proto-modal-stat-lbl">{l}</div>
    </div>
  );
}

function ActionButton({
  icon, title, help, state, onClick,
}: {
  icon: ReactNode;
  title: string;
  help: string;
  state: "idle" | "running" | "ok" | "err";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="proto-modal-action"
      onClick={onClick}
      disabled={state === "running"}
    >
      <span className="proto-modal-action-icon">{icon}</span>
      <span className="proto-modal-action-label">
        <span className="proto-modal-action-title">{title}</span>
        <span className="proto-modal-action-help">
          {state === "running" && "running…"}
          {state === "ok" && "✓ done"}
          {state === "err" && "× failed"}
          {state === "idle" && help}
        </span>
      </span>
    </button>
  );
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return `${Math.floor(diff / 86400_000)}d`;
}

function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}
