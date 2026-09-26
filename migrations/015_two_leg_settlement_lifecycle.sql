-- Each leg owns its signed payload and recovery data.  The old payout_intents
-- table is retained for historical compatibility; new settlement execution is
-- driven exclusively by these immutable, per-leg records.
ALTER TABLE settlement_legs ADD COLUMN IF NOT EXISTS sender_wallet TEXT;
ALTER TABLE settlement_legs ADD COLUMN IF NOT EXISTS gas_limit NUMERIC(30,0);
ALTER TABLE settlement_legs ADD COLUMN IF NOT EXISTS gas_price NUMERIC(30,0);
ALTER TABLE settlement_legs ADD COLUMN IF NOT EXISTS signed_transaction TEXT;
ALTER TABLE settlement_legs ADD COLUMN IF NOT EXISTS failure_code TEXT;
ALTER TABLE settlement_legs ADD COLUMN IF NOT EXISTS failure_message TEXT;

ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_status_check;
ALTER TABLE settlements ADD CONSTRAINT settlements_status_check CHECK (status IN (
  'pending','preparing','winner_submitted','winner_confirmed',
  'treasury_submitted','treasury_confirmed','settled','blocked','retryable','failed',
  'broadcast','confirmed'
));

ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_status_check;
ALTER TABLE rounds ADD CONSTRAINT rounds_status_check CHECK (status IN (
  'open','locked','ready_for_draw','waiting_for_randomness','winner_selected',
  'settlement_pending','payout_broadcast','payout_retryable','payout_confirmed',
  'payout_failed','drawing','completed','rolled_over'
));

DROP VIEW IF EXISTS reporting_settlement_summary;
CREATE VIEW reporting_settlement_summary AS
SELECT s.id AS settlement_id, s.round_id, s.status, s.settlement_basis AS gross_pool_base_units,
  s.winner_wallet, s.winner_amount, s.organizer_fee_accrued AS platform_gross_fee,
  s.treasury_wallet, s.treasury_amount,
  COALESCE(s.winner_gas_wei, 0) AS winner_gas_wei,
  COALESCE(s.treasury_gas_wei, 0) AS treasury_gas_wei,
  COALESCE(s.winner_gas_wei, 0) + COALESCE(s.treasury_gas_wei, 0) AS total_gas_wei,
  s.created_at, s.confirmed_at
FROM settlements s;
