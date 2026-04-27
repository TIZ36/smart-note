-- SmartNote Cloud — device registry + wrapped BYOK API key.
--
-- Decision A: each workspace has at most one `is_primary=true` device;
-- other devices are read mirrors. The primary is the default ws_relay
-- target for enrich jobs.
--
-- BYOK: the user's provider API key is *encrypted client-side* on the
-- primary device, then the wrapped blob is stored here so the desktop
-- can recover it across reinstalls. The cloud never sees the plaintext;
-- when a job dispatches via ws_relay the primary unwraps locally and
-- runs the call — the key never leaves the device for inference. We
-- keep the wrapped form here only as a recovery convenience.

CREATE TABLE IF NOT EXISTS devices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  platform        TEXT NOT NULL DEFAULT 'unknown',  -- darwin | win32 | linux | unknown
  is_primary      BOOLEAN NOT NULL DEFAULT false,
  pairing_code    TEXT,                             -- 6-digit, NULL once paired
  pairing_expires TIMESTAMPTZ,
  wrapped_api_key BYTEA,                            -- client-side encrypted BYOK blob
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devices_ws ON devices(workspace_id, is_primary DESC, last_seen_at DESC NULLS LAST);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_one_primary
  ON devices(workspace_id) WHERE is_primary = true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_pairing_code
  ON devices(pairing_code) WHERE pairing_code IS NOT NULL;
