import { useState, useEffect } from "react";
import { Save, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { readSettings, writeSettings, getHotkey, setHotkey } from "@/lib/electron";
import * as api from "@/lib/api";
import type { AppSettings } from "@/lib/types";
import { cn } from "@/lib/cn";
import { useTheme, type ThemeMode } from "@/hooks/useTheme";
import { CloudSyncSection } from "./CloudSyncSection";

const EASE_OUT_QUART = [0.25, 1, 0.5, 1] as const;

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
    ai_features_enabled: true,
    provider_base_url: "https://api.openai.com/v1",
    provider_api_key: "",
    provider_chat_model: "gpt-4o-mini",
    embed_base_url: "",
    embed_api_key: "",
    provider_embed_model: "text-embedding-3-small",
    ingest_ai_enabled: false,
    ingest_ai_model: "",
  });
  const [status, setStatus] = useState<{ text: string; type: "idle" | "success" | "error" }>({ text: "", type: "idle" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    setLoading(true);
    try {
      const s = await readSettings();
      setSettings(s);
      setStatus({ text: "", type: "idle" });
    } catch (err) {
      setStatus({ text: `Failed to load: ${String(err)}`, type: "error" });
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      const r = await writeSettings(settings);
      setStatus({ text: r.output || "Saved. Restart backend to apply.", type: "success" });
    } catch (err) {
      setStatus({ text: `Failed: ${String(err)}`, type: "error" });
    } finally {
      setSaving(false);
    }
  }

  function update<K extends keyof AppSettings>(field: K, value: AppSettings[K]) {
    setSettings((p) => ({ ...p, [field]: value }));
    // Clear status when user edits a field
    if (status.type !== "idle") setStatus({ text: "", type: "idle" });
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex-1 overflow-y-auto">
          <div className="proto-page-content">
            <div className="proto-settings-loading">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="proto-settings-loading-block">
                  <div className="proto-settings-loading-label animate-shimmer" />
                  <div className="proto-settings-loading-input animate-shimmer" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto">
        <div className="proto-page-content">
          <h1 className="proto-page-title">Settings</h1>

          <section className="proto-form-section">
            <h2 className="proto-form-section-title">Appearance</h2>
            <Field label="Theme">
              <div className="proto-settings-theme-group">
                {(["system", "light", "dark", "niho"] as ThemeMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setThemeMode(m)}
                    className={cn(
                      "proto-settings-theme-btn",
                      themeMode === m && "proto-settings-theme-btn-active"
                    )}
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
              <div className="proto-settings-hotkey-row">
                {hotkeyEditing ? (
                  <>
                    <input
                      type="text"
                      value={hotkeyInput}
                      onChange={(e) => setHotkeyInput(e.target.value)}
                      placeholder="e.g. CommandOrControl+Shift+V"
                      className="proto-form-input"
                      style={{ flex: 1 }}
                      autoFocus
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
                    <kbd className="proto-settings-kbd">
                      {hotkey.replace("CommandOrControl", "Cmd")}
                    </kbd>
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
              <select value={settings.embedding_mode} onChange={(e) => update("embedding_mode", e.target.value)} className="proto-form-input">
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
            <h2 className="proto-form-section-title">AI Features</h2>
            <p className="proto-form-hint proto-settings-section-hint">
              Master switch for every LLM call — chat answers, rerank, rewrite, ingest enrichment, wiki topic summaries.
              Embedding continues to work when this is off (uses the Embedding Provider below).
            </p>
            <div className="proto-toggle-row">
              <div>
                <div className="proto-toggle-label">Enable AI features</div>
                <div className="proto-toggle-desc">Turn off to fall back to non-LLM paths everywhere.</div>
              </div>
              <button
                type="button"
                aria-pressed={settings.ai_features_enabled}
                onClick={() => update("ai_features_enabled", !settings.ai_features_enabled)}
                className={cn("proto-toggle-switch", settings.ai_features_enabled && "proto-toggle-switch-on")}
              >
                <span className="proto-toggle-knob" />
              </button>
            </div>
          </section>

          <div className="proto-form-divider" />

          <section className="proto-form-section">
            <h2 className="proto-form-section-title">Chat Provider</h2>
            <p className="proto-form-hint proto-settings-section-hint">Used for AI answers, AI ingestion, and reranking.</p>
            <Field label="Base URL">
              <input type="text" value={settings.provider_base_url} onChange={(e) => update("provider_base_url", e.target.value)} placeholder="https://api.deepseek.com/v1" className="proto-form-input" />
            </Field>
            <Field label="API Key">
              <input type="password" value={settings.provider_api_key} onChange={(e) => update("provider_api_key", e.target.value)} placeholder="sk-..." className="proto-form-input" />
            </Field>
            <Field label="Chat Model">
              <input type="text" value={settings.provider_chat_model} onChange={(e) => update("provider_chat_model", e.target.value)} placeholder="deepseek-chat" className="proto-form-input" />
            </Field>
          </section>

          <div className="proto-form-divider" />

          <section className="proto-form-section">
            <h2 className="proto-form-section-title">
              Embedding Provider
              {settings.embedding_mode !== "api" && (
                <span className="proto-settings-section-note">
                  not used in {settings.embedding_mode} mode
                </span>
              )}
            </h2>
            <p className="proto-form-hint proto-settings-section-hint">
              Used when embedding mode is API. Leave blank to fall back to Chat Provider.
            </p>
            <Field label="Base URL (blank = same as Chat)">
              <input
                type="text"
                value={settings.embed_base_url}
                onChange={(e) => update("embed_base_url", e.target.value)}
                placeholder={settings.provider_base_url || "https://api.openai.com/v1"}
                disabled={settings.embedding_mode !== "api"}
                className="proto-form-input"
              />
            </Field>
            <Field label="API Key (blank = same as Chat)">
              <input
                type="password"
                value={settings.embed_api_key}
                onChange={(e) => update("embed_api_key", e.target.value)}
                placeholder={settings.embed_base_url ? "sk-..." : "(uses Chat API Key)"}
                disabled={settings.embedding_mode !== "api"}
                className="proto-form-input"
              />
            </Field>
            <Field label="Embed Model">
              <input
                type="text"
                value={settings.provider_embed_model}
                onChange={(e) => update("provider_embed_model", e.target.value)}
                placeholder="text-embedding-3-small"
                disabled={settings.embedding_mode !== "api"}
                className="proto-form-input"
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
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: EASE_OUT_QUART }}
                  className="overflow-hidden"
                >
                  <div className="proto-form-field mt-4">
                    <label className="proto-form-label">Ingestion Model (blank = Chat Model)</label>
                    <input type="text" value={settings.ingest_ai_model} onChange={(e) => update("ingest_ai_model", e.target.value)} placeholder={settings.provider_chat_model || "gpt-4o-mini"} className="proto-form-input" />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          <div className="proto-form-divider" />

          <CloudSyncSection settings={settings} update={update} />

          <div className="proto-form-divider" />

          <OcrSection />

          <div className="proto-form-divider" />

          <div className="proto-settings-save-row">
            <button type="button" onClick={handleSave} disabled={saving} className="proto-btn proto-btn-primary">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? "Saving..." : "Save"}
            </button>
            {status.text && (
              <span className={cn(
                "proto-settings-status",
                status.type === "success" && "proto-settings-status-success",
                status.type === "error" && "proto-settings-status-error"
              )}>
                {status.text}
              </span>
            )}
            {!status.text && (
              <span className="proto-settings-status">Restart backend after saving.</span>
            )}
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

// Common OCR languages users would want to select
const OCR_LANG_OPTIONS: { code: string; label: string }[] = [
  { code: "eng", label: "English" },
  { code: "chi_sim", label: "Chinese (Simplified)" },
  { code: "chi_tra", label: "Chinese (Traditional)" },
  { code: "jpn", label: "Japanese" },
  { code: "kor", label: "Korean" },
  { code: "fra", label: "French" },
  { code: "deu", label: "German" },
  { code: "spa", label: "Spanish" },
  { code: "rus", label: "Russian" },
  { code: "ara", label: "Arabic" },
];

function OcrSection() {
  const [installed, setInstalled] = useState<string[]>([]);
  const [hasTesseract, setHasTesseract] = useState(false);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.fetchOcrLangs().then((d) => {
      setInstalled(d.installed);
      setHasTesseract(d.has_tesseract);
      // Parse active config: "chi_sim+eng" → Set(["chi_sim", "eng"])
      if (d.active) {
        setActive(new Set(d.active.split("+").filter(Boolean)));
      }
    }).catch(() => {});
  }, []);

  function toggleLang(code: string) {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      // Auto-save
      const langStr = [...next].join("+");
      setSaving(true);
      api.saveOcrConfig(langStr).finally(() => setSaving(false));
      return next;
    });
  }

  // Filter to only show installed languages
  const available = OCR_LANG_OPTIONS.filter((o) => installed.includes(o.code));

  return (
    <section className="proto-form-section">
      <h2 className="proto-form-section-title">OCR (PDF Scanning)</h2>
      <p className="proto-form-hint proto-settings-section-hint">
        Select languages for scanned/image-only PDF import. Uses tesseract.
      </p>

      <div className="proto-form-field">
        <label className="proto-form-label">Tesseract</label>
        <span className={cn("proto-form-hint", hasTesseract ? "text-[var(--color-success)]" : "text-[var(--color-danger)]")}>
          {hasTesseract ? `Installed · ${installed.length} language packs` : "Not found — install via: brew install tesseract tesseract-lang"}
        </span>
      </div>

      {hasTesseract && available.length > 0 && (
        <div className="proto-form-field">
          <label className="proto-form-label">
            Active languages
            {saving && <Loader2 size={10} className="animate-spin" style={{ display: "inline", marginLeft: 6 }} />}
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {available.map((o) => (
              <button
                key={o.code}
                type="button"
                onClick={() => toggleLang(o.code)}
                className={cn("proto-ocr-lang-chip", active.has(o.code) && "proto-ocr-lang-chip-active")}
              >
                {o.label}
              </button>
            ))}
          </div>
          {active.size === 0 && (
            <p className="proto-form-hint" style={{ marginTop: 6 }}>
              No languages selected — OCR will auto-detect based on filename.
            </p>
          )}
        </div>
      )}

      {hasTesseract && available.length === 0 && installed.length === 0 && (
        <p className="proto-form-hint">
          No language packs found. Run: <code style={{ fontSize: 11, padding: "1px 4px", background: "var(--color-bg-elevated)", borderRadius: 3 }}>brew install tesseract-lang</code>
        </p>
      )}
    </section>
  );
}
