ALTER TABLE payout_intents DROP CONSTRAINT IF EXISTS payout_intents_status_check;
ALTER TABLE payout_intents ADD CONSTRAINT payout_intents_status_check CHECK (status IN ('pending', 'signed', 'broadcast', 'broadcast_unknown', 'retryable', 'manual_review', 'confirmed', 'failed'));
ALTER TABLE payout_intents ADD COLUMN IF NOT EXISTS signer_mode TEXT;
ALTER TABLE payout_intents ADD COLUMN IF NOT EXISTS signer_request_id TEXT;
ALTER TABLE payout_intents ADD COLUMN IF NOT EXISTS manual_approved_at TIMESTAMPTZ;
ALTER TABLE payout_intents ADD COLUMN IF NOT EXISTS manual_approved_by TEXT;
CREATE INDEX IF NOT EXISTS payout_intents_reconciliation_idx ON payout_intents (status, updated_at) WHERE status IN ('broadcast_unknown', 'broadcast', 'manual_review');
