"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Topbar } from "@/components/Topbar";
import { writeSession } from "@/lib/auth";
import { exchangeToken } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  // Default Cloud URL resolution (login is client-only so window exists):
  //   1. NEXT_PUBLIC_CLOUD_URL  — baked at build time (prod / known target)
  //   2. {protocol}//{host}:58000 — LAN / localhost auto-pick, so loading
  //      the console at http://10.x.x.x:3000 immediately offers the
  //      matching API URL without manual editing
  //   3. final fallback for SSR / no-window edge cases
  const [url, setUrl] = useState(
    process.env.NEXT_PUBLIC_CLOUD_URL
    || (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:58000` : "")
    || "https://cloud.smartnote.local"
  );
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!token.trim()) { setError("Token required"); return; }
    if (!url.trim())   { setError("Cloud URL required"); return; }
    setBusy(true); setError("");
    try {
      // Workspace API key → short-lived JWT. The exchange both validates
      // the key and gives us workspace_id + scopes to render on landing.
      const ex = await exchangeToken(url.trim(), token.trim());
      writeSession(url.trim(), token.trim(), ex);
      router.replace("/execution");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.toLowerCase().includes("invalid") ? "Invalid workspace token" : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <Topbar />
      <main className="login-wrap">
        <section className="login">
          <div>
            <h1>Sign in to your workspace</h1>
            <p className="login-copy">Read-only console — execution log, documents, notes, ask the cloud.</p>
          </div>
          <div className="login-fields">
            <div className="field">
              <label className="field-label" htmlFor="api-url">Cloud URL</label>
              <input id="api-url" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="token">Workspace token</label>
              <input
                id="token"
                type="password"
                placeholder="sn_live_…"
                value={token}
                onChange={(e) => { setToken(e.target.value); setError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              />
            </div>
          </div>
          <div className="login-actions">
            <button className="btn-primary" onClick={submit} disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            {error && <span className="error">{error}</span>}
          </div>
          <div className="login-hint">
            Need a token? Generate one from <a href="#">Desktop → Cloud → Workspace</a>.
          </div>
        </section>
      </main>
    </div>
  );
}
