ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_status_check;
ALTER TABLE rounds ADD CONSTRAINT rounds_status_check CHECK (status IN ('open', 'locked', 'ready_for_draw', 'waiting_for_randomness', 'winner_selected', 'settlement_pending', 'payout_broadcast', 'payout_retryable', 'payout_confirmed', 'payout_failed', 'drawing', 'completed', 'rolled_over'));

CREATE TABLE settlements (
  id UUID PRIMARY KEY,
  round_id UUID NOT NULL UNIQUE REFERENCES rounds(id),
  draw_result_id UUID NOT NULL UNIQUE REFERENCES draw_results(id),
  winner_wallet TEXT NOT NULL,
  settlement_basis NUMERIC(30, 0) NOT NULL CHECK (settlement_basis >= 0),
  organizer_fee_accrued NUMERIC(30, 0) NOT NULL CHECK (organizer_fee_accrued >= 0),
  winner_amount NUMERIC(30, 0) NOT NULL CHECK (winner_amount > 0),
  carry_in_amount NUMERIC(30, 0) NOT NULL CHECK (carry_in_amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'broadcast', 'retryable', 'confirmed', 'failed')),
  failure_code TEXT,
  failure_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  CHECK (winner_amount + organizer_fee_accrued = settlement_basis)
);

CREATE TABLE payout_intents (
  id UUID PRIMARY KEY,
  settlement_id UUID NOT NULL UNIQUE REFERENCES settlements(id),
  winner_wallet TEXT NOT NULL,
  winner_amount NUMERIC(30, 0) NOT NULL CHECK (winner_amount > 0),
  chain_id BIGINT NOT NULL,
  token_address TEXT NOT NULL,
  sender_wallet TEXT,
  nonce BIGINT,
  gas_limit NUMERIC(30, 0),
  gas_price NUMERIC(30, 0),
  signed_transaction TEXT,
  transaction_hash TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'signed', 'broadcast', 'retryable', 'confirmed', 'failed')),
  broadcast_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  confirmed_block_number BIGINT,
  network_fee_wei NUMERIC(30, 0),
  failure_code TEXT,
  failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((transaction_hash IS NULL AND signed_transaction IS NULL) OR (transaction_hash IS NOT NULL AND signed_transaction IS NOT NULL))
);

CREATE OR REPLACE FUNCTION require_settlement_for_completion() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed'
    AND NOT EXISTS (SELECT 1 FROM settlements WHERE round_id = NEW.id AND status = 'confirmed') THEN
    RAISE EXCEPTION 'A completed round requires a confirmed settlement';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER rounds_completion_requires_settlement BEFORE UPDATE OF status ON rounds FOR EACH ROW EXECUTE FUNCTION require_settlement_for_completion();
