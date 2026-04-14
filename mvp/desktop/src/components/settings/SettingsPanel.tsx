import { useState, useEffect } from "react";
import { Save } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { readSettings, writeSettings, getHotkey, setHotkey } from "@/lib/electron";
import type { AppSettings } from "@/lib/types";
import { cn } from "@/lib/cn";
import { useTheme, type ThemeMode } from "@/hooks/useTheme";

export function SettingsPanel() {
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const [hotkey, setHotkeyState] = useState("CommandOrControl+Shift+V");
  const [hotkeyEditing, setHotkeyEditing] = useState(false);
  const [hotkeyInput, setHotkeyInput] = useState("");

  useEffect(() => {
    getHotkey().then(setHotkeyState).catch(() => {});
  }, []);
  const [settings, setSettings] = useState<AppSettings>({
    embedding_mode: "local",
    provider_base_url: "https://api.openai.com/v1",
    provider_api_key: "",
    provider_chat_model: "gpt-4o-mini",
    embed_base_url: "",
    embed_api_key: "",
    provider_embed_model: "text-embedding-3-small",
    ingest_ai_enabled: false,
    ingest_ai_model: "",
  });
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    setLoading(true);
    try {
      const s = await readSettings();
      setSettings(s);
      setStatus("");
    } catch (err) {
      setStatus(`Failed: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    try {
      const r = await writeSettings(settings);
      setStatus(r.output);
    } catch (err) {
      setStatus(`Failed: ${String(err)}`);
    }
  }

  function update<K extends keyof AppSettings>(field: K, value: AppSettings[K]) {
    setSettings((p) => ({ ...p, [field]: value }));
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full text-[var(--color-text-muted)] text-[13px]">Loading...</div>;
  }

  const inputCls = "proto-form-input";

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto">
        <div className="proto-page-content">
          <h1 className="proto-page-title">Settings</h1>

          <section className="proto-form-section">
            <h2 className="proto-form-section-title">Appearance</h2>
            <Field label="Theme">
              <div style={{ display: "flex", gap: 6 }}>
                {(["system", "light", "dark"] as ThemeMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setThemeMode(m)}
                    className={cn(
                      "proto-btn",
                      themeMode === m ? "proto-btn-primary" : "proto-btn-secondary"
                    )}
                    style={{ flex: 1, justifyContent: "center", textTransform: "capitalize" }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </Field>
          </section>

          <div className="proto-form-divider" />

          <section className="proto-form-section">
            <h2 className="proto-form-section-title">Global Hotkey</h2>
            <Field label="Quick paste to raw file">
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {hotkeyEditing ? (
                  <>
                    <input
                      type="text"
                      value={hotkeyInput}
                      onChange={(e) => setHotkeyInput(e.target.value)}
                      placeholder="e.g. CommandOrControl+Shift+V"
                      className={inputCls}
                      style={{ flex: 1 }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          setHotkey(hotkeyInput || hotkey).then((r) => {
                            setHotkeyState(r.hotkey);
                            setHotkeyEditing(false);
                          });
                        }
                        if (e.key === "Escape") setHotkeyEditing(false);
                      }}
                    />
                    <button type="button" onClick={() => {
                      setHotkey(hotkeyInput || hotkey).then((r) => {
                        setHotkeyState(r.hotkey);
                        setHotkeyEditing(false);
                      });
                    }} className="proto-btn proto-btn-primary">Save</button>
                  </>
                ) : (
                  <>
                    <code style={{ fontSize: 13, color: "var(--color-text-primary)", background: "var(--color-bg-elevated)", padding: "4px 10px", borderRadius: "var(--radius-proto)" }}>
                      {hotkey.replace("CommandOrControl", "Cmd")}
                    </code>
                    <button type="button" onClick={() => { setHotkeyInput(hotkey); setHotkeyEditing(true); }} className="proto-btn proto-btn-secondary">Change</button>
                  </>
                )}
              </div>
              <p className="proto-form-hint">
                Press this shortcut anywhere to paste clipboard content to your raw file and trigger incremental ingest.
              </p>
            </Field>
          </section>

          <div className="proto-form-divider" />

          <section className="proto-form-section">
            <h2 className="proto-form-section-title">Embedding</h2>
            <Field label="Mode">
              <select value={settings.embedding_mode} onChange={(e) => update("embedding_mode", e.target.value)} className={inputCls}>
                <option value="mock">mock — hash-based, no network (dev only)</option>
                <option value="local">local — Docker embedding service (:8009)</option>
                <option value="api">api — OpenAI-compatible endpoint</option>
              </select>
              <p className="proto-form-hint">
                {settings.embedding_mode === "mock" && "No real embeddings — search uses keyword matching only."}
                {settings.embedding_mode === "local" && "Requires Docker. Run ./restart-docker.sh to start the service."}
                {settings.embedding_mode === "api" && "Uses the provider API below for both embedding and chat."}
              </p>
            </Field>
          </section>

          <div className="proto-form-divider" />

          <section className="proto-form-section">
            <h2 className="proto-form-section-title">Chat Provider</h2>
            <p className="proto-form-hint" style={{ marginBottom: 12 }}>Used for AI answers, AI ingestion, and reranking.</p>
            <Field label="Base URL">
              <input type="text" value={settings.provider_base_url} onChange={(e) => update("provider_base_url", e.target.value)} placeholder="https://api.deepseek.com/v1" className={inputCls} />
            </Field>
            <Field label="API Key">
              <input type="password" value={settings.provider_api_key} onChange={(e) => update("provider_api_key", e.target.value)} placeholder="sk-..." className={inputCls} />
            </Field>
            <Field label="Chat Model">
              <input type="text" value={settings.provider_chat_model} onChange={(e) => update("provider_chat_model", e.target.value)} placeholder="deepseek-chat" className={inputCls} />
            </Field>
          </section>

          <div className="proto-form-divider" />

          <section className="proto-form-section">
            <h2 className="proto-form-section-title">
              Embedding Provider
              {settings.embedding_mode !== "api" && (
                <span style={{ fontWeight: 400, fontSize: 11, color: "var(--color-text-muted)", marginLeft: 8 }}>
                  (not used in {settings.embedding_mode} mode)
                </span>
              )}
            </h2>
            <p className="proto-form-hint" style={{ marginBottom: 12 }}>
              Used when embedding mode = api. Leave blank to use the Chat Provider above.
            </p>
            <Field label="Base URL (blank = same as Chat)">
              <input
                type="text"
                value={settings.embed_base_url}
                onChange={(e) => update("embed_base_url", e.target.value)}
                placeholder={settings.provider_base_url || "https://api.openai.com/v1"}
                disabled={settings.embedding_mode !== "api"}
                className={cn(inputCls, settings.embedding_mode !== "api" && "opacity-30 cursor-not-allowed")}
              />
            </Field>
            <Field label="API Key (blank = same as Chat)">
              <input
                type="password"
                value={settings.embed_api_key}
                onChange={(e) => update("embed_api_key", e.target.value)}
                placeholder={settings.embed_base_url ? "sk-..." : "(uses Chat API Key)"}
                disabled={settings.embedding_mode !== "api"}
                className={cn(inputCls, settings.embedding_mode !== "api" && "opacity-30 cursor-not-allowed")}
              />
            </Field>
            <Field label="Embed Model">
              <input
                type="text"
                value={settings.provider_embed_model}
                onChange={(e) => update("provider_embed_model", e.target.value)}
                placeholder="text-embedding-3-small"
                disabled={settings.embedding_mode !== "api"}
                className={cn(inputCls, settings.embedding_mode !== "api" && "opacity-30 cursor-not-allowed")}
              />
            </Field>
          </section>

          <div className="proto-form-divider" />

          <section className="proto-form-section">
            <h2 className="proto-form-section-title">AI Ingestion</h2>
            <div className="proto-toggle-row">
              <div>
                <div className="proto-toggle-label">AI Classification</div>
                <div className="proto-toggle-desc">Dimension, keyword, entity extraction</div>
              </div>
              <button
                type="button"
                aria-pressed={settings.ingest_ai_enabled}
                onClick={() => update("ingest_ai_enabled", !settings.ingest_ai_enabled)}
                className={cn("proto-toggle-switch", settings.ingest_ai_enabled && "proto-toggle-switch-on")}
              >
                <span className="proto-toggle-knob" />
              </button>
            </div>

            <AnimatePresence>
              {settings.ingest_ai_enabled && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <div className="proto-form-field mt-4">
                    <label className="proto-form-label">Ingestion Model (blank = Chat Model)</label>
                    <input type="text" value={settings.ingest_ai_model} onChange={(e) => update("ingest_ai_model", e.target.value)} placeholder={settings.provider_chat_model || "gpt-4o-mini"} className={inputCls} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          <div className="proto-form-divider" />

          <div className="flex items-center gap-3 mt-2">
            <button type="button" onClick={handleSave} className="proto-btn proto-btn-primary">
              <Save size={14} /> Save
            </button>
            <span className="text-[11px] text-[var(--color-text-muted)]">{status || "Restart backend after saving."}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="proto-form-field">
      <label className="proto-form-label">{label}</label>
      {children}
    </div>
  );
}
