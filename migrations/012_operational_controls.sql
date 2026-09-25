CREATE TABLE IF NOT EXISTS operational_controls (
  control_name TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL DEFAULT 'migration'
);
INSERT INTO operational_controls (control_name, enabled) VALUES
  ('orders', true), ('payment_finalization', true), ('draws', true), ('payouts', true)
ON CONFLICT (control_name) DO NOTHING;
CREATE TABLE IF NOT EXISTS operational_audit_events (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operational_audit_events_created_at_idx ON operational_audit_events (created_at DESC);
