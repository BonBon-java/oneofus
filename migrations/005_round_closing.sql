-- A successor and a carry-over source are both one-to-one relationships.
-- These constraints make retries and concurrent closers unable to duplicate a
-- rollover even if an application-level lock is accidentally bypassed.
ALTER TABLE rounds ADD CONSTRAINT rounds_previous_round_unique UNIQUE (previous_round_id);
ALTER TABLE rounds ADD CONSTRAINT rounds_next_round_unique UNIQUE (next_round_id);

CREATE TABLE round_carry_overs (
  from_round_id UUID PRIMARY KEY REFERENCES rounds(id),
  to_round_id UUID NOT NULL UNIQUE REFERENCES rounds(id),
  amount NUMERIC(30, 0) NOT NULL CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_round_id <> to_round_id)
);

CREATE OR REPLACE FUNCTION prevent_ticket_issue_to_closed_round() RETURNS trigger AS $$
DECLARE round_status TEXT;
BEGIN
  SELECT status INTO round_status FROM rounds WHERE id = NEW.round_id FOR KEY SHARE;
  IF round_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'Tickets may only be issued to an open round';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ticket_ledger_open_round ON ticket_ledger_entries;
CREATE TRIGGER ticket_ledger_open_round BEFORE INSERT ON ticket_ledger_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ticket_issue_to_closed_round();
