/**
 * WebSocket presence + event relay between desktop and cloud.
 *
 *  desktop ──── /v1/device/relay (long-lived WS) ──── cloud
 *
 * Outbound:
 *   - hello on connect (announces device + version)
 *   - ping every 25s (heartbeat → cloud bumps last_seen_at)
 *
 * Inbound (forwarded to renderer via IPC channel "smartnote:ws-event"):
 *   - agent_active        — Claude/Cursor/Opencode just hit MCP
 *   - enrich_done         — a background enrich completed
 *   - memory_proposed     — agent submitted a memory for review
 *   - search_recorded     — agent ran search_memory / search_documents
 *   - hello-ack           — initial handshake reply
 *
 * Auto-reconnect with capped exponential backoff. Silent on errors —
 * presence is best-effort; never error-flash the UI.
 */

import { WebSocket } from "ws";
import * as settings from "./settings.mjs";

let _ws = null;
let _reconnectTimer = null;
let _pingTimer = null;
let _reconnectDelay = 1_000;       // start at 1s
const _RECONNECT_MAX = 30_000;     // cap at 30s
const _PING_MS = 25_000;
// Zombie-socket guard: if no inbound traffic (pong or otherwise)
// arrives within this window, treat the link as dead and reconnect.
// A 60s budget covers two missed pings before tearing down.
const _ZOMBIE_MS = 60_000;
let _stopped = false;
let _lastInboundAt = 0;
let _zombieTimer = null;

let _jwtCache = null;              // { jwt, expiresAt, key }
let _deviceId = null;              // resolved on first connect
let _emit = null;                  // renderer-bound emit function

export function setEmit(fn) { _emit = fn; }

async function _jwtFor(cloudUrl, apiKey) {
  const now = Math.floor(Date.now() / 1000);
  if (_jwtCache && _jwtCache.key === apiKey && _jwtCache.expiresAt - 60 > now) {
    return _jwtCache.jwt;
  }
  const r = await fetch(`${cloudUrl}/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!r.ok) throw new Error(`auth: ${r.status}`);
  const d = await r.json();
  _jwtCache = { jwt: d.jwt, expiresAt: d.expires_at, key: apiKey };
  return d.jwt;
}

async function _resolveDeviceId(cloudUrl, jwt) {
  // Look up devices to find the one matching THIS api_key. Cloud
  // returns is_primary first; for now just take the first online one
  // OR any one if none online. Fallback "unknown" — cloud accepts.
  try {
    const r = await fetch(`${cloudUrl}/v1/devices`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!r.ok) return "unknown";
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) return "unknown";
    // Prefer the primary device row; else the first non-ai-cli row.
    const primary = arr.find((d) => d.is_primary);
    const physical = arr.find((d) => d.platform !== "ai-cli");
    return (primary || physical || arr[0]).id;
  } catch {
    return "unknown";
  }
}

function _stop() {
  if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
  if (_zombieTimer) { clearInterval(_zombieTimer); _zombieTimer = null; }
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_ws) {
    try { _ws.terminate(); } catch {}
    _ws = null;
  }
}

async function _connectOnce() {
  try {
    return await _connectOnceInner();
  } catch (e) {
    // Most common cause: /v1/auth/token returns 401 because the
    // api_key in cloud-creds.json is no longer valid (workspace was
    // wiped via clean-all-data, key was rotated, etc). Without
    // catching here, the rejection propagates up to start() which is
    // called without a catch and produces an UnhandledPromiseRejection
    // every reconnect cycle. Log once + schedule retry.
    console.warn("[ws-presence] connect failed:", e?.message || e);
    _scheduleReconnect();
    return false;
  }
}

async function _connectOnceInner() {
  const s = await settings.read();
  if (!s.cloud_sync_url || !s.cloud_sync_api_key) {
    // No creds — schedule a low-frequency retry so the WS picks up
    // automatically once the user pastes a key in Cloud panel.
    // Without this, settings configured AFTER electron startup
    // would never get a WS connection until the next app restart.
    if (!_stopped && !_reconnectTimer) {
      _reconnectTimer = setTimeout(async () => {
        _reconnectTimer = null;
        await _connectOnce();
      }, 5_000);
    }
    return false;
  }
  const baseUrl = s.cloud_sync_url.replace(/\/+$/, "");
  const jwt = await _jwtFor(baseUrl, s.cloud_sync_api_key);
  if (!_deviceId) {
    _deviceId = await _resolveDeviceId(baseUrl, jwt);
  }
  // ws:// vs wss:// based on http vs https.
  const wsUrl = baseUrl.replace(/^http/, "ws") + `/v1/device/relay`
    + `?token=${encodeURIComponent(jwt)}&device_id=${encodeURIComponent(_deviceId)}`;

  return await new Promise((resolve) => {
    let resolved = false;
    const ws = new WebSocket(wsUrl);
    _ws = ws;
    ws.on("open", () => {
      _reconnectDelay = 1_000;
      _lastInboundAt = Date.now();
      try {
        ws.send(JSON.stringify({
          type: "hello",
          device_id: _deviceId,
          version: process.env.npm_package_version || "dev",
          platform: process.platform,
        }));
      } catch {}
      _pingTimer = setInterval(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        } catch {}
      }, _PING_MS);
      // Watchdog — if we stop hearing from cloud (no pongs, no events)
      // for _ZOMBIE_MS, the socket has silently died (NAT eviction,
      // suspended laptop, dropped link with no FIN). The OS may keep
      // it "OPEN" indefinitely, swallowing every event the cloud
      // pushes. Force-terminate so the close handler reconnects.
      _zombieTimer = setInterval(() => {
        if (Date.now() - _lastInboundAt > _ZOMBIE_MS) {
          try { ws.terminate(); } catch {}
        }
      }, _PING_MS);
      // Emit a synthetic "ws-recovered" event so the renderer can
      // reconcile state that may have drifted while we were
      // disconnected (in-flight processing rows, pipeline chips).
      if (typeof _emit === "function") {
        try { _emit({ type: "ws_recovered", at: new Date().toISOString() }); } catch {}
      }
      if (!resolved) { resolved = true; resolve(true); }
    });
    ws.on("message", (data) => {
      _lastInboundAt = Date.now();
      let payload;
      try { payload = JSON.parse(data.toString()); } catch { return; }
      // Diagnostic — confirms cloud→main WS leg is alive. Filter at
      // tail with `grep '\[ws-presence\]'` in the Electron stderr.
      const t = payload && payload.type;
      if (t && t !== "pong" && t !== "hello-ack") {
        console.log("[ws-presence] inbound", t,
          "run=", payload.run_id, "status=", payload.status,
          "doc=", payload.document_id);
      }
      // Forward every typed message to renderer. Renderer filters by type.
      if (typeof _emit === "function") {
        try { _emit(payload); } catch {}
      }
    });
    ws.on("pong", () => { _lastInboundAt = Date.now(); });
    ws.on("close", () => {
      if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
      if (_zombieTimer) { clearInterval(_zombieTimer); _zombieTimer = null; }
      _ws = null;
      if (!resolved) { resolved = true; resolve(false); }
      _scheduleReconnect();
    });
    ws.on("error", () => {
      // Errors trigger close; don't double-handle here.
    });
  });
}

function _scheduleReconnect() {
  if (_stopped) return;
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    await _connectOnce();
    // Exponential backoff with cap.
    _reconnectDelay = Math.min(_reconnectDelay * 2, _RECONNECT_MAX);
  }, _reconnectDelay);
}

export async function start() {
  _stopped = false;
  // Initial JWT cache invalidation in case settings changed.
  _jwtCache = null;
  _deviceId = null;
  await _connectOnce();
}

export async function stop() {
  _stopped = true;
  _stop();
}

/** Re-establish the WS connection. Called when settings change so a
 *  fresh URL / API key picks up without an Electron restart. Safe
 *  to call repeatedly; current socket gets torn down + re-dialled. */
export async function restart() {
  _stopped = false;
  _stop();                 // close any existing socket + timers
  _jwtCache = null;        // forget cached JWT (settings may have new key)
  _deviceId = null;
  _reconnectDelay = 1_000; // reset backoff so we connect quickly
  await _connectOnce();
}

export function status() {
  return {
    connected: _ws && _ws.readyState === WebSocket.OPEN,
    device_id: _deviceId,
    reconnect_delay: _reconnectDelay,
  };
}
