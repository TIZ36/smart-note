"""Minimal Python client for the SmartNote Cloud API.

Responsibilities:
  - Exchange API key for a JWT, auto-renew before expiry (30s margin).
  - Expose thin resource accessors for memories.

Intentionally does NOT paper over errors — a 4xx surfaces as a
structured exception so callers can distinguish auth/validation/quota.
"""

from __future__ import annotations

import time
from typing import Any

import httpx


class SmartNoteError(Exception):
    """Base class for all SDK errors. `status` is the HTTP status code
    the API returned (or None for transport-level failures)."""

    def __init__(self, message: str, *, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class SmartNoteAuthError(SmartNoteError):
    """401/403 — token rejected or missing required scope."""


class Client:
    """Bearer client.

    Usage:
        sn = Client(api_key="sn_live_...", base_url="http://localhost:8000")
        sn.memories.add(kind="preference", content="reply in Chinese")
        items = sn.memories.list(kind="preference")
    """

    # How early to refresh the JWT (seconds before `exp`). 30s is plenty
    # for clock skew + one round-trip, without thrashing the token endpoint.
    _REFRESH_MARGIN = 30

    def __init__(self, api_key: str, base_url: str = "http://localhost:58000", timeout: float = 15.0):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self._http = httpx.Client(timeout=timeout)
        self._jwt: str | None = None
        self._jwt_exp: int = 0
        self.memories = _MemoriesResource(self)
        self.proposals = _ProposalsResource(self)
        self.preferences = _PreferencesResource(self)
        self.documents = _DocumentsResource(self)
        self.retrieve = _RetrieveCallable(self)
        self.usage = _UsageResource(self)

    # ── public ──────────────────────────────────────────

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ── internals ───────────────────────────────────────

    def _ensure_token(self) -> str:
        now = int(time.time())
        if self._jwt and now + self._REFRESH_MARGIN < self._jwt_exp:
            return self._jwt
        # Exchange: POST /v1/auth/token with the api key.
        resp = self._http.post(
            f"{self.base_url}/v1/auth/token",
            json={"api_key": self.api_key},
        )
        if resp.status_code == 401:
            raise SmartNoteAuthError("api key rejected", status=401, body=_safe_json(resp))
        if resp.status_code >= 400:
            raise SmartNoteError(
                f"token exchange failed ({resp.status_code})",
                status=resp.status_code, body=_safe_json(resp),
            )
        data = resp.json()
        self._jwt = data["jwt"]
        self._jwt_exp = int(data["expires_at"])
        return self._jwt

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = kwargs.pop("headers", {}) or {}
        headers["Authorization"] = f"Bearer {self._ensure_token()}"
        resp = self._http.request(method, f"{self.base_url}{path}", headers=headers, **kwargs)
        # If our JWT expired between _ensure_token() and here (very rare),
        # retry once with a freshly-minted token.
        if resp.status_code == 401 and self._jwt:
            self._jwt = None
            self._jwt_exp = 0
            headers["Authorization"] = f"Bearer {self._ensure_token()}"
            resp = self._http.request(method, f"{self.base_url}{path}", headers=headers, **kwargs)
        if resp.status_code == 401:
            raise SmartNoteAuthError("unauthorized", status=401, body=_safe_json(resp))
        if resp.status_code == 403:
            raise SmartNoteAuthError("forbidden (scope)", status=403, body=_safe_json(resp))
        if resp.status_code >= 400:
            raise SmartNoteError(
                f"request failed ({resp.status_code}): {resp.text[:300]}",
                status=resp.status_code, body=_safe_json(resp),
            )
        return resp


class _MemoriesResource:
    def __init__(self, client: Client):
        self._c = client

    def add(
        self, kind: str, content: str, *,
        scope: str = "global",
        structured: dict | None = None,
        tags: list[str] | None = None,
        source_refs: list[dict] | None = None,
        confidence: float = 1.0,
        pinned: bool = False,
        supersedes: str | None = None,
    ) -> dict:
        body = {
            "kind": kind, "content": content, "scope": scope,
            "structured": structured, "tags": tags or [],
            "source_refs": source_refs or [],
            "confidence": confidence, "pinned": pinned,
            "supersedes": supersedes,
        }
        return self._c.request("POST", "/v1/memories", json=body).json()

    def list(
        self, *, kind: str | None = None, scope: str | None = None,
        limit: int = 50, offset: int = 0,
    ) -> list[dict]:
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if kind: params["kind"] = kind
        if scope: params["scope"] = scope
        return self._c.request("GET", "/v1/memories", params=params).json().get("memories", [])

    def get(self, memory_id: str) -> dict:
        return self._c.request("GET", f"/v1/memories/{memory_id}").json()

    def patch(self, memory_id: str, **updates: Any) -> dict:
        """Partial update. Only pass fields you want to change — others
        are left alone. Changing `content` re-embeds server-side."""
        return self._c.request("PATCH", f"/v1/memories/{memory_id}", json=updates).json()

    def delete(self, memory_id: str) -> None:
        self._c.request("DELETE", f"/v1/memories/{memory_id}")


class _ProposalsResource:
    """Memory proposal queue — MLflow autolog-style low-confidence
    candidates waiting for human/policy review before becoming active.
    """

    def __init__(self, client: "Client"):
        self._c = client

    def propose(
        self, kind: str, content: str, *,
        reason: str | None = None,
        scope: str = "global",
        tags: list[str] | None = None,
        structured: dict | None = None,
        confidence: float = 0.5,
    ) -> dict:
        body: dict[str, Any] = {
            "kind": kind, "content": content, "scope": scope,
            "tags": tags or [], "confidence": confidence,
        }
        if reason: body["reason"] = reason
        if structured is not None: body["structured"] = structured
        return self._c.request("POST", "/v1/memories/proposals", json=body).json()

    def list(
        self, *, kind: str | None = None, limit: int = 50, offset: int = 0,
    ) -> dict:
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if kind: params["kind"] = kind
        return self._c.request("GET", "/v1/memories/proposals", params=params).json()

    def accept(
        self, proposal_id: str, *,
        content: str | None = None,
        tags: list[str] | None = None,
        pinned: bool | None = None,
        confidence: float | None = None,
        supersedes: str | None = None,
    ) -> dict:
        body: dict[str, Any] = {}
        if content is not None: body["content"] = content
        if tags is not None: body["tags"] = tags
        if pinned is not None: body["pinned"] = pinned
        if confidence is not None: body["confidence"] = confidence
        if supersedes is not None: body["supersedes"] = supersedes
        return self._c.request(
            "POST", f"/v1/memories/proposals/{proposal_id}/accept", json=body,
        ).json()

    def reject(self, proposal_id: str, *, reason: str | None = None) -> dict:
        return self._c.request(
            "POST", f"/v1/memories/proposals/{proposal_id}/reject",
            json={"reason": reason} if reason else {},
        ).json()

    def batch_accept(self, ids: list[str]) -> dict:
        return self._c.request(
            "POST", "/v1/memories/proposals/batch-accept", json={"ids": ids},
        ).json()


class _PreferencesResource:
    def __init__(self, client: Client):
        self._c = client

    def all(self) -> dict:
        """Flat KV snapshot — `{key: {value, description, updated_at, ...}}`."""
        return self._c.request("GET", "/v1/preferences").json().get("preferences", {})

    def get(self, key: str) -> dict:
        return self._c.request("GET", f"/v1/preferences/{key}").json()

    def set(self, key: str, value: Any, *, description: str | None = None) -> dict:
        return self._c.request(
            "PUT", f"/v1/preferences/{key}",
            json={"value": value, "description": description},
        ).json()

    def delete(self, key: str) -> None:
        self._c.request("DELETE", f"/v1/preferences/{key}")


class _DocumentsResource:
    def __init__(self, client: Client):
        self._c = client

    def add(self, name: str, content: str, *, kind: str = "text", metadata: dict | None = None) -> dict:
        return self._c.request(
            "POST", "/v1/documents",
            json={"name": name, "content": content, "kind": kind, "metadata": metadata},
        ).json()

    def ingest(self, document_id: str) -> dict:
        return self._c.request("POST", f"/v1/documents/{document_id}/ingest").json()

    def list(self) -> list[dict]:
        return self._c.request("GET", "/v1/documents").json().get("documents", [])

    def get(self, document_id: str) -> dict:
        return self._c.request("GET", f"/v1/documents/{document_id}").json()


class _RetrieveCallable:
    """Callable resource — `client.retrieve("...")` is more ergonomic than
    `client.retrieve.query("...")` for the top-level primitive."""

    def __init__(self, client: Client):
        self._c = client

    def __call__(
        self, query: str, *,
        kinds: list[str] | None = None,
        scope: str | None = None,
        tags: list[str] | None = None,
        topk: int = 10,
        vector_weight: float = 0.7,
        lexical_weight: float = 0.3,
    ) -> dict:
        body: dict[str, Any] = {
            "query": query, "topk": topk,
            "vector_weight": vector_weight, "lexical_weight": lexical_weight,
        }
        if kinds: body["kinds"] = kinds
        if scope: body["scope"] = scope
        if tags: body["tags"] = tags
        return self._c.request("POST", "/v1/retrieve", json=body).json()


class _UsageResource:
    def __init__(self, client: Client):
        self._c = client

    def current(self) -> dict:
        return self._c.request("GET", "/v1/usage").json()


def _safe_json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except Exception:
        return resp.text
