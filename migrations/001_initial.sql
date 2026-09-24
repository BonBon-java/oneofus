CREATE TABLE IF NOT EXISTS participants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  payout_wallet TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  participant_id UUID NOT NULL REFERENCES participants(id),
  ticket_quantity INTEGER NOT NULL CHECK (ticket_quantity > 0),
  sending_source TEXT NOT NULL,
  base_ticket_amount NUMERIC(30, 0) NOT NULL,
  ticket_value_amount NUMERIC(30, 0) NOT NULL,
  identification_amount NUMERIC(30, 0) NOT NULL,
  payment_code INTEGER NOT NULL,
  expected_payment_amount NUMERIC(30, 0) NOT NULL,
  payment_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  cooldown_until TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  transaction_hash TEXT,
  transaction_log_index INTEGER,
  block_number BIGINT,
  received_amount NUMERIC(30, 0),
  ticket_range_start BIGINT,
  ticket_range_end BIGINT,
  CHECK (payment_status IN ('pending', 'payment_detected', 'paid', 'expired', 'late_payment', 'duplicate_payment', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS orders_paid_at_idx ON orders (payment_status, paid_at DESC);
CREATE INDEX IF NOT EXISTS orders_participant_today_idx ON orders (participant_id, payment_status, paid_at DESC);

CREATE TABLE IF NOT EXISTS payment_code_reservations (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
  full_expected_amount NUMERIC(30, 0) NOT NULL,
  payment_code INTEGER NOT NULL,
  status TEXT NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  cooldown_until TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS active_payment_amount_unique ON payment_code_reservations (full_expected_amount) WHERE active;

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  token_address TEXT NOT NULL,
  from_address TEXT,
  to_address TEXT NOT NULL,
  received_amount NUMERIC(30, 0) NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  payment_status TEXT NOT NULL,
  UNIQUE (transaction_hash, log_index)
);

CREATE TABLE IF NOT EXISTS ticket_ranges (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
  participant_id UUID NOT NULL REFERENCES participants(id),
  start_ticket BIGINT NOT NULL,
  end_ticket BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (start_ticket <= end_ticket)
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_range_start_unique ON ticket_ranges (start_ticket);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_range_end_unique ON ticket_ranges (end_ticket);

CREATE TABLE IF NOT EXISTS app_counters (
  name TEXT PRIMARY KEY,
  next_value BIGINT NOT NULL
);
INSERT INTO app_counters (name, next_value) VALUES ('ticket', 1) ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS scanner_state (
  scanner_name TEXT PRIMARY KEY,
  last_processed_block BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS draw_history (
  id UUID PRIMARY KEY,
  draw_date TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'pending', 'rolled_over')),
  total_paid_tickets INTEGER NOT NULL,
  pool_amount NUMERIC(30, 0) NOT NULL,
  prize_amount NUMERIC(30, 0) NOT NULL,
  winner_name TEXT,
  winner_payout_wallet TEXT,
  winning_ticket_number BIGINT,
  payout_transaction_hash TEXT,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS draw_history_completed_idx ON draw_history (status, draw_date DESC);
