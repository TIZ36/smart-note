import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Sparkles, X, ExternalLink, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  fetchMcpInstallerStatus, installMcpForAgent, uninstallMcpForAgent,
  STACK_IPC_UNAVAILABLE,
  type McpInstallerAgentStatus,
} from "@/lib/electron";

/* One-click MCP installer — the single highest-ROI flow in the whole
   app. Without this, the core value prop ("your AI tools now remember
   what you know") lives behind a JSON config file the user has to
   edit by hand — 90% of would-be users bounce there.

   The card surfaces three agents (Claude Code, Cursor, OpenCode) with
   per-agent state: Available / Installed / Malformed config. One click
   writes the URL + Authorization header into the agent's user-scope
   MCP config, merging with any existing entries the user has. */

type Props = {
  url: string;
  apiKey: string;
};

type AgentMeta = {
  id: string;
  label: string;
  hint: string;
  docHint?: string;
};

const AGENTS: AgentMeta[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "~/.claude.json",
  },
  {
    id: "cursor",
    label: "Cursor",
    hint: "~/.cursor/mcp.json",
    docHint: "Restart Cursor after install.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    hint: "~/.config/opencode/opencode.json",
  },
];

export function AgentInstallerCard({ url, apiKey }: Props) {
  const [status, setStatus] = useState<Record<string, McpInstallerAgentStatus> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ agent: string; msg: string; kind: "ok" | "err" } | null>(null);
  const [ipcUnavailable, setIpcUnavailable] = useState(false);

  const hasConfig = Boolean(url && apiKey);

  const refresh = useCallback(async () => {
    const r = await fetchMcpInstallerStatus();
    if (!r.ok) {
      setIpcUnavailable(true);
      return;
    }
    setIpcUnavailable(false);
    setStatus(r.agents);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function handleInstall(agentId: string) {
    if (busy || !hasConfig) return;
    setBusy(agentId);
    setFlash(null);
    const r = await installMcpForAgent(agentId, url, apiKey);
    if (r.error === STACK_IPC_UNAVAILABLE) {
      setIpcUnavailable(true);
      setBusy(null);
      return;
    }
    if (r.ok) {
      setFlash({ agent: agentId, kind: "ok", msg: r.replaced ? "Updated existing config" : "Installed" });
      await refresh();
    } else {
      setFlash({ agent: agentId, kind: "err", msg: r.error || "install failed" });
    }
    setBusy(null);
    setTimeout(() => setFlash((f) => (f?.agent === agentId ? null : f)), 3500);
  }

  async function handleUninstall(agentId: string) {
    if (busy) return;
    setBusy(agentId);
    setFlash(null);
    const r = await uninstallMcpForAgent(agentId);
    if (r.ok) {
      setFlash({ agent: agentId, kind: "ok", msg: r.removed ? "Removed" : "Already absent" });
      await refresh();
    } else {
      setFlash({ agent: agentId, kind: "err", msg: r.error || "remove failed" });
    }
    setBusy(null);
    setTimeout(() => setFlash((f) => (f?.agent === agentId ? null : f)), 3500);
  }

  if (ipcUnavailable) {
    // Old main process without our handlers — render a quiet hint
    // instead of hiding the card entirely, so the user knows the
    // feature exists once they relaunch.
    return (
      <section className="proto-cloud-sync-card">
        <h2 className="proto-cloud-sync-card-title">
          <Sparkles size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Connect your agents
        </h2>
        <p className="proto-form-hint">
          One-click installer unavailable — quit and relaunch the desktop app to enable.
        </p>
      </section>
    );
  }

  return (
    <section className="proto-cloud-sync-card">
      <h2 className="proto-cloud-sync-card-title">
        <Sparkles size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
        Connect your agents
      </h2>
      <p className="proto-form-hint" style={{ marginBottom: 14 }}>
        One click adds SmartNote Cloud to each agent's MCP config (user scope).
        Merges safely with any existing entries you have.
        {!hasConfig && (
          <>
            {" "}
            <strong>Save credentials above first.</strong>
          </>
        )}
      </p>

      <div className="proto-agent-installer-grid">
        {AGENTS.map((agent) => {
          const s = status?.[agent.id];
          const installed = Boolean(s?.installed);
          const malformed = Boolean(s?.malformed);
          const isBusy = busy === agent.id;
          const myFlash = flash?.agent === agent.id ? flash : null;
          return (
            <div
              key={agent.id}
              className={cn(
                "proto-agent-installer-tile",
                installed && "proto-agent-installer-tile-installed",
              )}
            >
              <div className="proto-agent-installer-head">
                <span className="proto-agent-installer-label">{agent.label}</span>
                {installed && (
                  <span className="proto-agent-installer-badge" title="Installed">
                    <CheckCircle2 size={10} /> installed
                  </span>
                )}
              </div>
              <div className="proto-agent-installer-path">{agent.hint}</div>
              {malformed && (
                <div className="proto-agent-installer-warning">
                  <AlertTriangle size={11} /> config file isn't valid JSON — fix or delete it first
                </div>
              )}
              <div className="proto-agent-installer-actions">
                <button
                  type="button"
                  className={cn("proto-btn", installed ? "proto-btn" : "proto-btn-primary")}
                  onClick={() => handleInstall(agent.id)}
                  disabled={isBusy || !hasConfig || malformed}
                  title={!hasConfig ? "Save credentials above first" : undefined}
                >
                  {isBusy ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
                  {installed ? "Reinstall" : "Install"}
                </button>
                {installed && (
                  <button
                    type="button"
                    className="proto-btn proto-agent-installer-remove"
                    onClick={() => handleUninstall(agent.id)}
                    disabled={isBusy}
                    aria-label="Uninstall"
                    title="Remove from config"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              {myFlash && (
                <div
                  className={cn(
                    "proto-agent-installer-flash",
                    myFlash.kind === "ok"
                      ? "proto-agent-installer-flash-ok"
                      : "proto-agent-installer-flash-err",
                  )}
                >
                  {myFlash.msg}
                </div>
              )}
              {agent.docHint && installed && (
                <div className="proto-agent-installer-hint">{agent.docHint}</div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
