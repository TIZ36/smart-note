-- SmartNote Cloud — link api_keys to devices for the pairing flow.
--
-- The Apple-TV-style pair → claim flow mints a new api_key when a new
-- device redeems a 6-digit code. Tracking which device "owns" the key
-- buys us:
--   * unpair → revoke the device's key in one transaction (no orphan
--     keys lingering with admin scope),
--   * console UI can show "this key belongs to <device>" instead of
--     just the opaque key name.
--
-- Optional column — pre-existing keys (issued via /v1/dev/bootstrap or
-- the console) keep device_id NULL.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES devices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_device
  ON api_keys(device_id) WHERE device_id IS NOT NULL;
