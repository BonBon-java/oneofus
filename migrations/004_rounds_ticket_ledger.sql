-- A round is the accounting boundary for one UTC lottery day. Draw execution is
-- deliberately not part of this migration; the status and carry fields make it
-- possible to implement that lifecycle without reinterpreting past payments.
CREATE TABLE IF NOT EXISTS rounds (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('open', 'locked', 'drawing', 'completed', 'rolled_over')),
  opens_at TIMESTAMPTZ NOT NULL UNIQUE,
  closes_at TIMESTAMPTZ NOT NULL,
  draw_at TIMESTAMPTZ NOT NULL,
  previous_round_id UUID REFERENCES rounds(id),
  next_round_id UUID REFERENCES rounds(id),
  carry_in_amount NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (carry_in_amount >= 0),
  gross_pool_amount NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (gross_pool_amount >= 0),
  organizer_fee_amount NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (organizer_fee_amount >= 0),
  winner_pool_amount NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (winner_pool_amount >= 0),
  paid_ticket_count INTEGER NOT NULL DEFAULT 0 CHECK (paid_ticket_count >= 0),
  free_ticket_count INTEGER NOT NULL DEFAULT 0 CHECK (free_ticket_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at),
  CHECK (draw_at >= closes_at)
);

CREATE OR REPLACE FUNCTION prevent_underfilled_round_draw() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('drawing', 'completed') AND NEW.paid_ticket_count < 10 THEN
    RAISE EXCEPTION 'A round needs at least 10 paid tickets before drawing';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS rounds_minimum_paid_tickets ON rounds;
CREATE TRIGGER rounds_minimum_paid_tickets BEFORE INSERT OR UPDATE OF status, paid_ticket_count ON rounds
FOR EACH ROW EXECUTE FUNCTION prevent_underfilled_round_draw();

-- Existing orders predate formal rounds. Backfill them deterministically by
-- their UTC creation day, so all historical issued tickets become auditable.
INSERT INTO rounds (id, status, opens_at, closes_at, draw_at, carry_in_amount, gross_pool_amount, organizer_fee_amount, winner_pool_amount, paid_ticket_count, free_ticket_count, created_at, updated_at)
SELECT md5('legacy-round-' || utc_day::text)::uuid, 'locked', utc_day, utc_day + interval '1 day', utc_day + interval '1 day', 0, 0, 0, 0, 0, 0, now(), now()
FROM (SELECT DISTINCT date_trunc('day', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS utc_day FROM orders) days
ON CONFLICT (opens_at) DO NOTHING;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS round_id UUID REFERENCES rounds(id);
UPDATE orders o SET round_id = r.id FROM rounds r WHERE o.round_id IS NULL AND o.created_at >= r.opens_at AND o.created_at < r.closes_at;
ALTER TABLE orders ALTER COLUMN round_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS orders_round_status_idx ON orders (round_id, payment_status);

ALTER TABLE ticket_ranges ADD COLUMN IF NOT EXISTS round_id UUID REFERENCES rounds(id);
UPDATE ticket_ranges t SET round_id = o.round_id FROM orders o WHERE t.order_id = o.id AND t.round_id IS NULL;
ALTER TABLE ticket_ranges ALTER COLUMN round_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS ticket_ledger_entries (
  id UUID PRIMARY KEY,
  round_id UUID NOT NULL REFERENCES rounds(id),
  order_id UUID UNIQUE REFERENCES orders(id),
  participant_id UUID NOT NULL REFERENCES participants(id),
  payment_id UUID UNIQUE REFERENCES payments(id),
  ticket_type TEXT NOT NULL CHECK (ticket_type IN ('paid', 'free')),
  cause TEXT NOT NULL,
  ticket_count INTEGER NOT NULL CHECK (ticket_count > 0),
  start_ticket BIGINT NOT NULL,
  end_ticket BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_ticket - start_ticket + 1 = ticket_count),
  CHECK ((ticket_type = 'paid' AND order_id IS NOT NULL AND payment_id IS NOT NULL) OR ticket_type = 'free')
);
CREATE INDEX IF NOT EXISTS ticket_ledger_round_idx ON ticket_ledger_entries (round_id, ticket_type, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_ledger_ticket_start_unique ON ticket_ledger_entries (start_ticket);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_ledger_ticket_end_unique ON ticket_ledger_entries (end_ticket);
-- A transfer transaction can be credited only once, even if it includes more
-- than one matching ERC-20 log.
CREATE UNIQUE INDEX IF NOT EXISTS payments_transaction_hash_unique ON payments (transaction_hash);

INSERT INTO ticket_ledger_entries (id, round_id, order_id, participant_id, payment_id, ticket_type, cause, ticket_count, start_ticket, end_ticket, created_at)
SELECT md5('legacy-ledger-' || t.id::text)::uuid, t.round_id, t.order_id, t.participant_id, p.id, 'paid', 'legacy_import', (t.end_ticket - t.start_ticket + 1)::integer, t.start_ticket, t.end_ticket, t.created_at
FROM ticket_ranges t
JOIN payments p ON p.order_id = t.order_id AND p.payment_status = 'confirmed'
ON CONFLICT (order_id) DO NOTHING;

-- Keep round counters reconcilable with the source-of-truth ledger. Historical
-- pool values are not reconstructed because prior fee/carry rules are unknown.
UPDATE rounds r SET paid_ticket_count = totals.paid_ticket_count, free_ticket_count = totals.free_ticket_count, updated_at = now()
FROM (
  SELECT round_id,
    COALESCE(SUM(ticket_count) FILTER (WHERE ticket_type = 'paid'), 0)::integer AS paid_ticket_count,
    COALESCE(SUM(ticket_count) FILTER (WHERE ticket_type = 'free'), 0)::integer AS free_ticket_count
  FROM ticket_ledger_entries GROUP BY round_id
) totals WHERE r.id = totals.round_id;

-- Reserve every amount that the existing zero-placement matcher accepts. The
-- recursive CTE emits all six-decimal placements of each non-zero identifier.
WITH RECURSIVE placements AS (
  SELECT r.order_id, r.base_amount, r.identifier, 0 AS position, 0 AS digit_position, ''::text AS fraction,
         r.reserved_at, r.expires_at, r.cooldown_until, r.active
  FROM payment_identifier_reservations r WHERE r.active AND r.cooldown_until > now()
  UNION ALL
  SELECT p.order_id, p.base_amount, p.identifier, p.position + 1, p.digit_position + choice.consume,
         p.fraction || choice.character, p.reserved_at, p.expires_at, p.cooldown_until, p.active
  FROM placements p
  CROSS JOIN LATERAL (
    VALUES ('0'::text, 0),
      (substring(p.identifier FROM p.digit_position + 1 FOR 1), 1)
  ) AS choice(character, consume)
  WHERE p.position < 6
    AND ((choice.consume = 0 AND 5 - p.position >= length(p.identifier) - p.digit_position)
      OR (choice.consume = 1 AND p.digit_position < length(p.identifier)))
)
INSERT INTO payment_amount_reservations (id, order_id, amount, kind, reserved_at, expires_at, cooldown_until, active)
SELECT md5('payment-alias-' || order_id::text || '-' || fraction)::uuid, order_id,
       base_amount * 1000000 + fraction::numeric,
       CASE WHEN fraction::numeric = (SELECT full_expected_amount % 1000000 FROM payment_code_reservations c WHERE c.order_id = placements.order_id) THEN 'exact' ELSE 'alias' END,
       reserved_at, expires_at, cooldown_until, active
FROM placements
WHERE position = 6 AND digit_position = length(identifier)
  AND NOT EXISTS (SELECT 1 FROM payment_amount_reservations existing WHERE existing.order_id = placements.order_id AND existing.amount = placements.base_amount * 1000000 + placements.fraction::numeric);
