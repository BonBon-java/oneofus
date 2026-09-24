ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_status_check;
ALTER TABLE rounds ADD CONSTRAINT rounds_status_check CHECK (status IN ('open', 'locked', 'ready_for_draw', 'drawing', 'completed', 'rolled_over'));

CREATE OR REPLACE FUNCTION prevent_underfilled_round_draw() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('ready_for_draw', 'drawing', 'completed') AND NEW.paid_ticket_count < 10 THEN
    RAISE EXCEPTION 'A round needs at least 10 paid tickets before drawing';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE draw_snapshots (
  id UUID PRIMARY KEY,
  round_id UUID NOT NULL UNIQUE REFERENCES rounds(id),
  snapshot_hash TEXT NOT NULL UNIQUE CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  paid_ticket_count INTEGER NOT NULL CHECK (paid_ticket_count >= 10),
  free_ticket_count INTEGER NOT NULL CHECK (free_ticket_count >= 0),
  total_eligible_ticket_count INTEGER NOT NULL CHECK (total_eligible_ticket_count > 0),
  gross_pool_amount NUMERIC(30, 0) NOT NULL CHECK (gross_pool_amount >= 0),
  organizer_fee_amount NUMERIC(30, 0) NOT NULL CHECK (organizer_fee_amount >= 0),
  winner_pool_amount NUMERIC(30, 0) NOT NULL CHECK (winner_pool_amount >= 0),
  carry_in_amount NUMERIC(30, 0) NOT NULL CHECK (carry_in_amount >= 0),
  total_winner_eligible_amount NUMERIC(30, 0) NOT NULL CHECK (total_winner_eligible_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (paid_ticket_count + free_ticket_count = total_eligible_ticket_count),
  CHECK (winner_pool_amount + carry_in_amount = total_winner_eligible_amount)
);

CREATE TABLE draw_snapshot_ranges (
  id UUID PRIMARY KEY,
  snapshot_id UUID NOT NULL REFERENCES draw_snapshots(id),
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  ledger_entry_id UUID NOT NULL REFERENCES ticket_ledger_entries(id),
  participant_id UUID NOT NULL REFERENCES participants(id),
  payout_wallet TEXT NOT NULL,
  ticket_type TEXT NOT NULL CHECK (ticket_type IN ('paid', 'free')),
  cause TEXT NOT NULL,
  payment_id UUID REFERENCES payments(id),
  source_start_ticket BIGINT NOT NULL,
  source_end_ticket BIGINT NOT NULL,
  start_ticket BIGINT NOT NULL,
  end_ticket BIGINT NOT NULL,
  ticket_count INTEGER NOT NULL CHECK (ticket_count > 0),
  CHECK (source_end_ticket - source_start_ticket + 1 = ticket_count),
  CHECK (end_ticket - start_ticket + 1 = ticket_count),
  UNIQUE (snapshot_id, sequence_number),
  UNIQUE (snapshot_id, ledger_entry_id),
  UNIQUE (snapshot_id, start_ticket),
  UNIQUE (snapshot_id, end_ticket)
);

CREATE OR REPLACE FUNCTION require_snapshot_for_ready_round() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'ready_for_draw' AND OLD.status IS DISTINCT FROM 'ready_for_draw'
    AND NOT EXISTS (
      SELECT 1 FROM draw_snapshots s
      WHERE s.round_id = NEW.id
        AND s.total_eligible_ticket_count = COALESCE((SELECT SUM(ticket_count) FROM draw_snapshot_ranges r WHERE r.snapshot_id = s.id), 0)
    ) THEN
    RAISE EXCEPTION 'A ready-for-draw round requires an immutable draw snapshot';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER rounds_ready_requires_snapshot BEFORE UPDATE OF status ON rounds
FOR EACH ROW EXECUTE FUNCTION require_snapshot_for_ready_round();

CREATE OR REPLACE FUNCTION prevent_finalized_snapshot_range_insert() RETURNS trigger AS $$
DECLARE round_status TEXT;
BEGIN
  SELECT r.status INTO round_status FROM draw_snapshots s JOIN rounds r ON r.id = s.round_id WHERE s.id = NEW.snapshot_id FOR KEY SHARE;
  IF round_status IS DISTINCT FROM 'locked' THEN
    RAISE EXCEPTION 'Ranges may only be inserted while a snapshot is being finalized';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER draw_snapshot_ranges_finalize_once BEFORE INSERT ON draw_snapshot_ranges
FOR EACH ROW EXECUTE FUNCTION prevent_finalized_snapshot_range_insert();

CREATE OR REPLACE FUNCTION prevent_draw_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Draw snapshots are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER draw_snapshots_immutable BEFORE UPDATE OR DELETE ON draw_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_draw_snapshot_mutation();
CREATE TRIGGER draw_snapshot_ranges_immutable BEFORE UPDATE OR DELETE ON draw_snapshot_ranges
FOR EACH ROW EXECUTE FUNCTION prevent_draw_snapshot_mutation();
