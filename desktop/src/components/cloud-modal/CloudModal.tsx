import { useEffect, useState, type ReactNode } from "react";
import { X, Calendar, Cpu, Bot, Save, Loader2 } from "lucide-react";
import * as cloudApi from "@/lib/cloud-api";
import { readSettings, writeSettings } from "@/lib/electron";

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
  const [actionState, setActionState] = useState<Record<string, "idle" | "running" | "ok" | "err">>({});
  const [mcpUrl, setMcpUrl] = useState<string>("—");
  const [apiKey, setApiKey] = useState<string>("");
  const [agentChoice, setAgentChoice] = useState<"claude" | "cursor" | "opencode">("claude");
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState<"url" | "key" | null>(null);

  // Top-level functional tab — splits the modal into 4 self-contained
  // surfaces (Connection · Provider · Workspace · MCP) so each one
  // owns its own vertical space and the user can find a setting
  // without scrolling through everything else.
  const [tab, setTab] = useState<"connection" | "provider" | "workspace" | "mcp">("connection");

  // Connection settings (was in Settings → SmartNote Cloud).
  const [connDraft, setConnDraft] = useState<{
    cloud_sync_url: string;
    cloud_sync_api_key: string;
    cloud_sync_enabled: boolean;
  } | null>(null);
  const [connSaving, setConnSaving] = useState(false);
  const [connFlash, setConnFlash] = useState<"" | "ok" | "err">("");

  // Enrich provider config — drives both /v1/enrich/run (cloud_pool
  // executor) and wiki_abstract. Without this, both surface 412.
  const [provider, setProvider] = useState<cloudApi.EnrichProviderConfig | null>(null);
  const [providerDraft, setProviderDraft] = useState<{
    base_url: string;
    api_key: string;       // empty string ⇒ leave key untouched on save
    model: string;
    max_concurrency: number;
    auto_enrich_on_ingest: boolean;
  } | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerFlash, setProviderFlash] = useState<"" | "ok" | "err">("");

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

  // Cloud connection settings (URL + API key + sync toggle) live
  // here now — they're cloud-scope, not local. MCP endpoint is
  // derived from cloud_sync_url so both stay in sync via one source.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    readSettings().then((s) => {
      if (!alive) return;
      const url = (s.cloud_sync_url || "").trim();
      const key = (s.cloud_sync_api_key || "").trim();
      setMcpUrl(url ? `${url.replace(/\/$/, "")}/mcp` : "—");
      setApiKey(key);
      setConnDraft({
        cloud_sync_url: url,
        cloud_sync_api_key: key,
        cloud_sync_enabled: s.cloud_sync_enabled !== false,
      });
    }).catch(() => {
      if (alive) {
        setMcpUrl("—");
        setApiKey("");
        setConnDraft({ cloud_sync_url: "", cloud_sync_api_key: "", cloud_sync_enabled: true });
      }
    });
    return () => { alive = false; };
  }, [open]);

  // Pull current cloud-side enrich provider on open. We never get
  // the api_key back (server returns has_api_key bool only) — the
  // password input stays empty unless the user types a new value.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    cloudApi.fetchEnrichProvider()
      .then((cfg) => {
        if (!alive) return;
        setProvider(cfg);
        setProviderDraft({
          base_url: cfg.base_url || "",
          api_key: "",
          model: cfg.model || "",
          max_concurrency: cfg.max_concurrency || 4,
          auto_enrich_on_ingest: cfg.auto_enrich_on_ingest,
        });
      })
      .catch(() => {
        if (!alive) return;
        // No cloud configured yet — show empty draft, save will fail
        // until connection is set, which is the intended UX flow.
        setProvider(null);
        setProviderDraft({
          base_url: "https://api.deepseek.com/v1",
          api_key: "",
          model: "deepseek-chat",
          max_concurrency: 4,
          auto_enrich_on_ingest: false,
        });
      });
    return () => { alive = false; };
  }, [open]);

  async function saveConnection() {
    if (!connDraft) return;
    setConnSaving(true);
    setConnFlash("");
    try {
      // writeSettings expects a full AppSettings object — splice the
      // 3 cloud fields onto whatever the rest of settings currently is.
      const current = await readSettings();
      await writeSettings({ ...current, ...connDraft });
      const url = connDraft.cloud_sync_url.trim();
      setMcpUrl(url ? `${url.replace(/\/$/, "")}/mcp` : "—");
      setApiKey(connDraft.cloud_sync_api_key.trim());
      setConnFlash("ok");
      setTimeout(() => setConnFlash(""), 1600);
    } catch {
      setConnFlash("err");
      setTimeout(() => setConnFlash(""), 2200);
    } finally {
      setConnSaving(false);
    }
  }

  async function saveProvider() {
    if (!providerDraft) return;
    setProviderSaving(true);
    setProviderFlash("");
    try {
      // Only send api_key when the user actually typed one; empty
      // string ⇒ "leave existing key alone" (otherwise we'd nuke
      // the stored key every time the user adjusts model/concurrency).
      const patch: cloudApi.EnrichProviderUpdate = {
        base_url: providerDraft.base_url,
        model: providerDraft.model,
        max_concurrency: providerDraft.max_concurrency,
        auto_enrich_on_ingest: providerDraft.auto_enrich_on_ingest,
      };
      if (providerDraft.api_key.trim()) {
        patch.api_key = providerDraft.api_key.trim();
      }
      const cfg = await cloudApi.saveEnrichProvider(patch);
      setProvider(cfg);
      setProviderDraft((d) => d && ({ ...d, api_key: "" }));
      setProviderFlash("ok");
      setTimeout(() => setProviderFlash(""), 1600);
    } catch {
      setProviderFlash("err");
      setTimeout(() => setProviderFlash(""), 2400);
    } finally {
      setProviderSaving(false);
    }
  }

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
          <div className="proto-modal-title">Cloud settings</div>
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
          <nav className="proto-modal-tabs" role="tablist" aria-label="Cloud settings">
            {([
              { key: "connection", label: "Connection" },
              { key: "provider", label: "AI provider", flag: provider?.has_api_key ? "ok" : "warn" },
              { key: "workspace", label: "Workspace" },
              { key: "mcp", label: "MCP" },
            ] as const).map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cn("proto-modal-tab", tab === t.key && "proto-modal-tab-active")}
              >
                {t.label}
                {t.key === "connection" && !apiKey && (
                  <span className="proto-modal-tab-dot proto-modal-tab-dot-warn" title="not configured" />
                )}
                {t.key === "provider" && (
                  <span
                    className={cn(
                      "proto-modal-tab-dot",
                      provider?.has_api_key ? "proto-modal-tab-dot-ok" : "proto-modal-tab-dot-warn",
                    )}
                    title={provider?.has_api_key ? "key set" : "no key — wiki / enrich won't run"}
                  />
                )}
              </button>
            ))}
          </nav>

          {tab === "connection" && (<>
          {/* Connection — cloud URL + workspace API key + sync toggle.
              Moved here from Settings (which is local-only now). */}
          <div className="proto-modal-section">
            <div className="proto-modal-section-title">Connection</div>
            {connDraft && (
              <>
                <CloudField label="Cloud URL">
                  <input
                    type="text"
                    className="proto-form-input"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    placeholder="https://api.smartnote.cloud"
                    value={connDraft.cloud_sync_url}
                    onChange={(e) => setConnDraft({ ...connDraft, cloud_sync_url: e.target.value })}
                  />
                </CloudField>
                <CloudField label="Workspace API key">
                  <input
                    type="password"
                    className="proto-form-input"
                    placeholder="wsk_…"
                    value={connDraft.cloud_sync_api_key}
                    onChange={(e) => setConnDraft({ ...connDraft, cloud_sync_api_key: e.target.value })}
                  />
                </CloudField>
                <label className="proto-form-toggle-label" style={{ marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={connDraft.cloud_sync_enabled}
                    onChange={(e) => setConnDraft({ ...connDraft, cloud_sync_enabled: e.target.checked })}
                  />
                  <span style={{ fontSize: 12 }}>Sync notes / wiki / tables on save</span>
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                  <button
                    type="button"
                    className="proto-btn proto-btn-primary"
                    onClick={saveConnection}
                    disabled={connSaving}
                  >
                    {connSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                    {connSaving ? "Saving…" : "Save connection"}
                  </button>
                  {connFlash === "ok" && <span style={{ fontSize: 11, color: "var(--color-success)" }}>✓ saved</span>}
                  {connFlash === "err" && <span style={{ fontSize: 11, color: "var(--color-danger)" }}>save failed</span>}
                </div>
              </>
            )}
          </div>
          </>)}

          {tab === "workspace" && (<>
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
          </>)}

          {tab === "provider" && (<>
          {/* Cloud-side enrich provider — powers /v1/enrich/run AND
              wiki abstract. Without an api_key here, both 412. */}
          <div className="proto-modal-section">
            <div className="proto-modal-section-title">
              Cloud AI provider · enrich + wiki abstract
              {provider?.has_api_key && (
                <span style={{ fontSize: 10, color: "var(--color-success)", marginLeft: 8, textTransform: "none", letterSpacing: 0 }}>
                  ✓ key set
                </span>
              )}
            </div>
            {providerDraft && (
              <>
                <CloudField label="Base URL">
                  <input
                    type="text"
                    className="proto-form-input"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    placeholder="https://api.deepseek.com/v1"
                    value={providerDraft.base_url}
                    onChange={(e) => setProviderDraft({ ...providerDraft, base_url: e.target.value })}
                  />
                </CloudField>
                <CloudField label={`API key${provider?.has_api_key ? " (blank = keep existing)" : ""}`}>
                  <input
                    type="password"
                    className="proto-form-input"
                    placeholder={provider?.has_api_key ? "•••••••• (leave empty to keep)" : "sk-…"}
                    value={providerDraft.api_key}
                    onChange={(e) => setProviderDraft({ ...providerDraft, api_key: e.target.value })}
                  />
                </CloudField>
                <CloudField label="Model">
                  <input
                    type="text"
                    className="proto-form-input"
                    placeholder="deepseek-chat"
                    value={providerDraft.model}
                    onChange={(e) => setProviderDraft({ ...providerDraft, model: e.target.value })}
                  />
                </CloudField>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <CloudField label="Max concurrency">
                    <input
                      type="number"
                      min={1}
                      max={16}
                      className="proto-form-input"
                      value={providerDraft.max_concurrency}
                      onChange={(e) => setProviderDraft({ ...providerDraft, max_concurrency: Math.max(1, Math.min(16, Number(e.target.value) || 1)) })}
                    />
                  </CloudField>
                  <label className="proto-form-toggle-label" style={{ alignSelf: "end", paddingBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={providerDraft.auto_enrich_on_ingest}
                      onChange={(e) => setProviderDraft({ ...providerDraft, auto_enrich_on_ingest: e.target.checked })}
                    />
                    <span style={{ fontSize: 12 }}>Auto-enrich on save</span>
                  </label>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                  <button
                    type="button"
                    className="proto-btn proto-btn-primary"
                    onClick={saveProvider}
                    disabled={providerSaving}
                  >
                    {providerSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                    {providerSaving ? "Saving…" : "Save provider"}
                  </button>
                  {providerFlash === "ok" && <span style={{ fontSize: 11, color: "var(--color-success)" }}>✓ saved</span>}
                  {providerFlash === "err" && <span style={{ fontSize: 11, color: "var(--color-danger)" }}>save failed (cloud unreachable?)</span>}
                </div>
                <div className="proto-form-hint" style={{ marginTop: 4 }}>
                  Off by default. Each enrich / wiki-abstract run consumes LLM
                  tokens at the configured provider's rate.
                </div>
              </>
            )}
          </div>
          </>)}

          {tab === "mcp" && (<>
          {/* MCP endpoint — drop-in JSON config per AI CLI. Pre-fills
              URL + API key (key shown masked, copies as plaintext). */}
          <div className="proto-modal-section">
            <div className="proto-modal-section-title">MCP endpoint for AI agents</div>
            {mcpUrl === "—" || !apiKey ? (
              <div className="proto-modal-line-help" style={{ paddingLeft: 0 }}>
                Set <strong>Cloud URL</strong> and <strong>API key</strong> in
                Connection above first — the MCP endpoint and per-agent JSON
                snippets are derived from them.
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
          </>)}

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

function CloudField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="proto-form-field" style={{ marginBottom: 6 }}>
      <label className="proto-form-label" style={{ fontSize: 11 }}>{label}</label>
      {children}
    </div>
  );
}
