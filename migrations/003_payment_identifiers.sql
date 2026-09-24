CREATE TABLE IF NOT EXISTS payment_identifier_reservations (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
  base_amount NUMERIC(30, 0) NOT NULL,
  identifier TEXT NOT NULL CHECK (identifier ~ '^[1-9]+$'),
  reserved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  cooldown_until TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);

-- The identifier is every non-zero fractional digit, but base_amount is still
-- exact: 1.001 and 1.01 share code "1", whereas 0.000001 never matches them.
INSERT INTO payment_identifier_reservations (id, order_id, base_amount, identifier, reserved_at, expires_at, cooldown_until, active)
SELECT md5(random()::text || clock_timestamp()::text || order_id::text || 'identifier')::uuid, order_id, full_expected_amount / 1000000,
       regexp_replace(lpad((full_expected_amount % 1000000)::text, 6, '0'), '0', '', 'g'),
       reserved_at, expires_at, cooldown_until, active AND cooldown_until > now()
FROM payment_code_reservations
WHERE regexp_replace(lpad((full_expected_amount % 1000000)::text, 6, '0'), '0', '', 'g') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS active_payment_identifier_reservation_unique ON payment_identifier_reservations (base_amount, identifier) WHERE active;
CREATE INDEX IF NOT EXISTS payment_identifier_reservations_lookup_idx ON payment_identifier_reservations (base_amount, identifier, active);
