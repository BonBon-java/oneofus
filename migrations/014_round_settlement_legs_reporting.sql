ALTER TABLE settlements ADD COLUMN IF NOT EXISTS treasury_wallet TEXT;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS treasury_amount NUMERIC(30, 0);
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS winner_gas_wei NUMERIC(30, 0);
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS treasury_gas_wei NUMERIC(30, 0);
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS gas_balance_wei NUMERIC(30, 0);

CREATE TABLE IF NOT EXISTS settlement_legs (
  id UUID PRIMARY KEY,
  settlement_id UUID NOT NULL REFERENCES settlements(id),
  kind TEXT NOT NULL CHECK (kind IN ('winner_payout', 'treasury_sweep')),
  recipient_wallet TEXT NOT NULL,
  amount NUMERIC(30, 0) NOT NULL CHECK (amount > 0),
  chain_id BIGINT NOT NULL,
  token_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed','broadcast','broadcast_unknown','manual_review','confirmed','failed')),
  nonce BIGINT,
  transaction_hash TEXT UNIQUE,
  gas_used NUMERIC(30,0),
  effective_gas_price NUMERIC(30,0),
  gas_cost_wei NUMERIC(30,0),
  broadcast_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (settlement_id, kind)
);
CREATE INDEX IF NOT EXISTS settlement_legs_status_idx ON settlement_legs(status, updated_at);

CREATE OR REPLACE VIEW reporting_settlement_summary AS
SELECT s.id AS settlement_id, s.round_id, s.status, s.settlement_basis AS gross_pool_base_units,
  s.winner_wallet, s.winner_amount, s.organizer_fee_accrued AS platform_gross_fee,
  s.treasury_wallet, s.treasury_amount,
  COALESCE(s.winner_gas_wei, 0) + COALESCE(s.treasury_gas_wei, 0) AS total_gas_wei,
  s.created_at, s.confirmed_at
FROM settlements s;
