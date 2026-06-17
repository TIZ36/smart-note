// Cloud workspace API keys (`sn_live_…`) are NOT bearer tokens on their
// own — they must be exchanged for a short-lived JWT via
// `POST /v1/auth/token`. We keep the original api_key around so we can
// re-exchange transparently when the JWT expires (~1h).

const URL_KEY     = "sn.console.url";
const KEY_KEY     = "sn.console.apikey";
const JWT_KEY     = "sn.console.jwt";
const EXP_KEY     = "sn.console.jwt_exp";       // epoch seconds
const WS_KEY      = "sn.console.workspace_id";
const SCOPES_KEY  = "sn.console.scopes";

export type Session = {
  url: string;
  apiKey: string;
  jwt: string;
  jwtExp: number;
  workspaceId: string;
  scopes: string[];
  workspaceLabel: string;
};

export function readSession(): Session | null {
  if (typeof window === "undefined") return null;
  const url    = localStorage.getItem(URL_KEY);
  const apiKey = localStorage.getItem(KEY_KEY);
  const jwt    = localStorage.getItem(JWT_KEY);
  const exp    = Number(localStorage.getItem(EXP_KEY) || "0");
  const wsId   = localStorage.getItem(WS_KEY) || "";
  if (!url || !apiKey || !jwt) return null;
  return {
    url, apiKey, jwt, jwtExp: exp, workspaceId: wsId,
    scopes: JSON.parse(localStorage.getItem(SCOPES_KEY) || "[]"),
    workspaceLabel: wsId ? `ws_${wsId.slice(0, 6)} · connected` : "workspace · connected",
  };
}

export function writeSession(url: string, apiKey: string, exchange: {
  jwt: string; expires_at: number; workspace_id: string; scopes: string[];
}) {
  localStorage.setItem(URL_KEY, url.replace(/\/+$/, ""));
  localStorage.setItem(KEY_KEY, apiKey);
  localStorage.setItem(JWT_KEY, exchange.jwt);
  localStorage.setItem(EXP_KEY, String(exchange.expires_at));
  localStorage.setItem(WS_KEY,  exchange.workspace_id);
  localStorage.setItem(SCOPES_KEY, JSON.stringify(exchange.scopes));
}

export function updateJwt(jwt: string, expires_at: number) {
  localStorage.setItem(JWT_KEY, jwt);
  localStorage.setItem(EXP_KEY, String(expires_at));
}

export function clearSession() {
  for (const k of [URL_KEY, KEY_KEY, JWT_KEY, EXP_KEY, WS_KEY, SCOPES_KEY]) {
    localStorage.removeItem(k);
  }
}

// True when the JWT is expired or within a 60s skew window.
export function jwtExpired(s: Session): boolean {
  return !s.jwtExp || s.jwtExp <= Math.floor(Date.now() / 1000) + 60;
}
