# smartnote-cloud (Python SDK)

Official Python client for the SmartNote Cloud API.

**Status:** placeholder. Shipping alongside the first working API endpoints
in W3–W4.

Planned shape:

```python
from smartnote_cloud import Client

sn = Client(api_key="sn_live_...")          # stored locally; token auto-renewed
sn.preferences.set("code_style", "concise")
sn.memories.add(kind="fact", content="User lives in Shanghai")
results = sn.retrieve("preferred git commit format")
```

The SDK owns:
- Token exchange (api_key → JWT) and refresh cycle
- Exponential backoff on transient errors
- Per-session embedding-request batching
- Structured errors (`AuthError`, `QuotaError`, `ValidationError`)
