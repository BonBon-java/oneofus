CREATE TABLE IF NOT EXISTS payment_amount_reservations (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id),
  amount NUMERIC(30, 0) NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('exact', 'alias')),
  reserved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  cooldown_until TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);
-- Preserve existing exact reservations and deterministically backfill the same
-- aliases used by the earlier one-zero compatibility rule. A collision aborts
-- migration safely; migration 003 adds the current identifier reservations.
INSERT INTO payment_amount_reservations (id, order_id, amount, kind, reserved_at, expires_at, cooldown_until, active)
SELECT md5(random()::text || clock_timestamp()::text || order_id::text)::uuid, order_id, full_expected_amount, 'exact', reserved_at, expires_at, cooldown_until, active AND cooldown_until > now()
FROM payment_code_reservations
ON CONFLICT DO NOTHING;

WITH source AS (
  SELECT r.*, (r.full_expected_amount / 1000000)::numeric AS whole, ((r.full_expected_amount % 1000000) / 100)::integer AS fraction
  FROM payment_code_reservations r WHERE r.active AND r.cooldown_until > now()
), digits AS (
  SELECT source.*, lpad(fraction::text, 4, '0') AS value FROM source
), aliases AS (
  SELECT *, substring(value FROM pos FOR 1) || substring(value FROM pos + 2) AS shortened
  FROM digits CROSS JOIN generate_series(1, 3) AS positions(pos)
  WHERE substring(value FROM pos FOR 1) = '0' AND substring(value FROM pos + 1 FOR 1) <> '0'
)
INSERT INTO payment_amount_reservations (id, order_id, amount, kind, reserved_at, expires_at, cooldown_until, active)
SELECT md5(random()::text || clock_timestamp()::text || order_id::text || shortened)::uuid, order_id, whole * 1000000 + shortened::numeric * 1000, 'alias', reserved_at, expires_at, cooldown_until, true
FROM aliases;

CREATE UNIQUE INDEX IF NOT EXISTS active_payment_amount_reservation_unique ON payment_amount_reservations (amount) WHERE active;
CREATE INDEX IF NOT EXISTS payment_amount_reservations_lookup_idx ON payment_amount_reservations (amount, kind, active);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS matched_by TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(30, 0);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS matched_amount NUMERIC(30, 0);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_status_check CHECK (payment_status IN ('unmatched', 'manual_review', 'payment_detected', 'confirmed', 'late_payment', 'duplicate_payment'));
