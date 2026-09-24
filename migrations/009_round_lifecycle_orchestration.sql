CREATE TABLE round_lifecycle_runs (
  round_id UUID PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
  worker_id TEXT,
  claim_until TIMESTAMPTZ,
  last_action TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX round_lifecycle_runs_next_attempt_idx ON round_lifecycle_runs (next_attempt_at)
  WHERE next_attempt_at IS NOT NULL;
