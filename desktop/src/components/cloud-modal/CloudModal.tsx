import { useEffect, useState, type ReactNode } from "react";
import { X, Calendar, Cpu, Bot } from "lucide-react";
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
  const [apiKey, setApiKey] = useState<string>("");
  const [agentChoice, setAgentChoice] = useState<"claude" | "cursor" | "opencode">("claude");
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState<"url" | "key" | null>(null);

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

  // MCP endpoint + API key from persistent app settings (Settings →
  // SmartNote Cloud). Both are needed to render the per-agent JSON
  // config snippets the user can paste into their CLI directly.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    readSettings().then((s) => {
      if (!alive) return;
      const url = (s.cloud_sync_url || "").trim();
      if (url) setMcpUrl(`${url.replace(/\/$/, "")}/mcp`);
      else setMcpUrl("—");
      setApiKey((s.cloud_sync_api_key || "").trim());
    }).catch(() => {
      if (alive) { setMcpUrl("—"); setApiKey(""); }
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

  // Mask all but a leading prefix + trailing suffix so the key is
  // visible enough to be recognizable (matches what the user pasted)
  // but never exposed in screenshots / over-the-shoulder views.
  function maskKey(k: string): string {
    if (!k) return "—";
    if (k.length <= 12) return "•".repeat(k.length);
    return `${k.slice(0, 8)}${"•".repeat(8)}${k.slice(-4)}`;
  }

  async function copyRawValue(kind: "url" | "key") {
    const value = kind === "url" ? mcpUrl : apiKey;
    if (!value || value === "—") return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedRaw(kind);
      setTimeout(() => setCopiedRaw(null), 1400);
    } catch { /* silent */ }
  }

  // Per-agent MCP server JSON snippets. Each agent has its own
  // config file path and slightly different schema; we generate
  // ready-to-paste blocks pre-filled with the user's URL + API key.
  function configFor(agent: "claude" | "cursor" | "opencode"): string {
    if (mcpUrl === "—" || !apiKey) {
      return "// Configure URL + API key in Settings → SmartNote Cloud first.";
    }
    const auth = `Bearer ${apiKey}`;
    if (agent === "claude") {
      return JSON.stringify({
        mcpServers: {
          "smartnote-cloud": {
            type: "http",
            url: mcpUrl,
            headers: { Authorization: auth },
          },
        },
      }, null, 2);
    }
    if (agent === "cursor") {
      return JSON.stringify({
        mcpServers: {
          "smartnote-cloud": {
            url: mcpUrl,
            headers: { Authorization: auth },
          },
        },
      }, null, 2);
    }
    // opencode
    return JSON.stringify({
      mcp: {
        "smartnote-cloud": {
          type: "remote",
          url: mcpUrl,
          headers: { Authorization: auth },
        },
      },
    }, null, 2);
  }

  function configPathFor(agent: "claude" | "cursor" | "opencode"): string {
    if (agent === "claude")  return "~/.claude.json (mcpServers section) or per-project .mcp.json";
    if (agent === "cursor")  return "~/.cursor/mcp.json or <project>/.cursor/mcp.json";
    return "~/.config/opencode/opencode.json";
  }

  async function copyConfig() {
    const text = configFor(agentChoice);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedConfig(true);
      setTimeout(() => setCopiedConfig(false), 1600);
    } catch { /* silent */ }
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

          {/* Devices + connected agents — physical devices first,
              then AI CLI virtual devices (auto-registered when an
              agent first connects via MCP with its User-Agent). */}
          <div className="proto-modal-section">
            <div className="proto-modal-section-title">Devices · connected agents</div>
            {devices === null
              ? <div className="proto-modal-row-meta">loading…</div>
              : devices.length === 0
                ? <div className="proto-modal-row-meta">no devices paired yet</div>
                : (() => {
                  const physical = devices.filter((d) => d.platform !== "ai-cli");
                  const agents = devices.filter((d) => d.platform === "ai-cli");
                  return (
                    <>
                      {physical.slice(0, 4).map((d) => (
                        <DeviceRow key={d.id} d={d} kind="device" />
                      ))}
                      {agents.length > 0 && (
                        <>
                          {physical.length > 0 && (
                            <div style={{ height: 1, background: "var(--color-border)", margin: "6px 0" }} />
                          )}
                          {agents.slice(0, 6).map((d) => (
                            <DeviceRow key={d.id} d={d} kind="agent" />
                          ))}
                        </>
                      )}
                    </>
                  );
                })()}
          </div>

          {/* Workspace-level action — only Run today's digest lives
              here. Per-document processing (Upload to wiki, enrich,
              tag, smartsheet) belongs on KP, not buried in this
              modal. */}
          <div className="proto-modal-section">
            <div className="proto-modal-section-title">Workspace action</div>
            <div className="proto-modal-actions-stack">
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

          {/* MCP endpoint — drop-in JSON config per AI CLI. Pre-fills
              URL + API key (key shown masked, copies as plaintext). */}
          <div className="proto-modal-section">
            <div className="proto-modal-section-title">MCP endpoint for AI agents</div>
            {mcpUrl === "—" || !apiKey ? (
              <div className="proto-modal-line-help" style={{ paddingLeft: 0 }}>
                Open <strong>Settings → SmartNote Cloud</strong> to add your
                cloud URL and workspace API key. Once set, ready-to-paste
                JSON snippets for Claude Code / Cursor / Opencode will appear
                here.
              </div>
            ) : (
              <>
                {/* URL + masked API key with individual copy buttons */}
                <div className="proto-modal-mcp">
                  <span style={{ fontSize: 10, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginRight: 6 }}>URL</span>
                  <span className="proto-modal-mcp-text">{mcpUrl}</span>
                  <button
                    type="button"
                    className="proto-modal-mcp-copy"
                    onClick={() => copyRawValue("url")}
                  >
                    {copiedRaw === "url" ? "copied" : "copy"}
                  </button>
                </div>
                <div className="proto-modal-mcp" style={{ marginTop: 6 }}>
                  <span style={{ fontSize: 10, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginRight: 6 }}>KEY</span>
                  <span className="proto-modal-mcp-text">{maskKey(apiKey)}</span>
                  <button
                    type="button"
                    className="proto-modal-mcp-copy"
                    onClick={() => copyRawValue("key")}
                    title="Copy plaintext API key (display is masked)"
                  >
                    {copiedRaw === "key" ? "copied" : "copy"}
                  </button>
                </div>

                {/* Agent picker */}
                <div className="proto-modal-mcp-agents">
                  {([
                    { id: "claude",   label: "Claude Code" },
                    { id: "cursor",   label: "Cursor" },
                    { id: "opencode", label: "Opencode" },
                  ] as const).map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setAgentChoice(a.id)}
                      className={cn(
                        "proto-modal-mcp-agent",
                        agentChoice === a.id && "proto-modal-mcp-agent-active",
                      )}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>

                {/* JSON config block (masked display, plaintext copy) */}
                <pre className="proto-modal-mcp-json">
                  <code>
                    {configFor(agentChoice)
                      .replace(`Bearer ${apiKey}`, `Bearer ${maskKey(apiKey)}`)}
                  </code>
                </pre>
                <div className="proto-modal-mcp-actions">
                  <button
                    type="button"
                    className="proto-modal-mcp-copy-btn"
                    onClick={copyConfig}
                  >
                    {copiedConfig ? "✓ Copied with plaintext key" : "Copy config"}
                  </button>
                  <span className="proto-modal-mcp-hint">
                    paste into <code>{configPathFor(agentChoice)}</code>
                  </span>
                </div>
              </>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

function DeviceRow({ d, kind }: { d: cloudApi.Device; kind: "device" | "agent" }) {
  const Icon = kind === "agent" ? Bot : Cpu;
  return (
    <div className="proto-modal-row">
      <span className="proto-modal-row-icon" style={{ color: kind === "agent" ? "var(--color-accent)" : "var(--color-text-muted)" }}>
        <Icon size={12} strokeWidth={1.8} />
      </span>
      <span className="proto-modal-row-name">
        {d.name || d.id.slice(0, 8)}
        {d.is_primary && " · primary"}
        {kind === "agent" && (
          <span style={{ fontSize: 9.5, color: "var(--color-text-muted)", marginLeft: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            agent
          </span>
        )}
      </span>
      <span className="proto-modal-row-meta">
        {d.last_seen_at ? `last seen ${relTime(d.last_seen_at)}` : "—"}
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
