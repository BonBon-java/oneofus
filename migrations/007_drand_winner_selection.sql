ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_status_check;
ALTER TABLE rounds ADD CONSTRAINT rounds_status_check CHECK (status IN ('open', 'locked', 'ready_for_draw', 'waiting_for_randomness', 'winner_selected', 'drawing', 'completed', 'rolled_over'));

CREATE TABLE drand_commitments (
  id UUID PRIMARY KEY,
  snapshot_id UUID NOT NULL UNIQUE REFERENCES draw_snapshots(id),
  round_id UUID NOT NULL UNIQUE REFERENCES rounds(id),
  snapshot_finalized_at TIMESTAMPTZ NOT NULL,
  network_id TEXT NOT NULL,
  chain_hash TEXT NOT NULL CHECK (chain_hash ~ '^[0-9a-f]{64}$'),
  public_key TEXT NOT NULL,
  scheme_id TEXT NOT NULL,
  genesis_time BIGINT NOT NULL,
  period_seconds INTEGER NOT NULL CHECK (period_seconds > 0),
  drand_round BIGINT NOT NULL CHECK (drand_round > 0),
  scheduled_at TIMESTAMPTZ NOT NULL,
  algorithm_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (scheduled_at > snapshot_finalized_at)
);

CREATE TABLE draw_results (
  id UUID PRIMARY KEY,
  round_id UUID NOT NULL UNIQUE REFERENCES rounds(id),
  snapshot_id UUID NOT NULL UNIQUE REFERENCES draw_snapshots(id),
  commitment_id UUID NOT NULL UNIQUE REFERENCES drand_commitments(id),
  network_id TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  drand_round BIGINT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  randomness TEXT NOT NULL CHECK (randomness ~ '^[0-9a-f]{64}$'),
  signature TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  rejection_counter BIGINT NOT NULL CHECK (rejection_counter >= 0),
  total_eligible_ticket_count INTEGER NOT NULL CHECK (total_eligible_ticket_count > 0),
  winning_ticket BIGINT NOT NULL CHECK (winning_ticket > 0),
  winning_snapshot_range_id UUID NOT NULL REFERENCES draw_snapshot_ranges(id),
  winner_participant_id UUID NOT NULL REFERENCES participants(id),
  winner_payout_wallet TEXT NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (winning_ticket <= total_eligible_ticket_count)
);

CREATE OR REPLACE FUNCTION prevent_underfilled_round_draw() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('ready_for_draw', 'waiting_for_randomness', 'winner_selected', 'drawing', 'completed') AND NEW.paid_ticket_count < 10 THEN
    RAISE EXCEPTION 'A round needs at least 10 paid tickets before drawing';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION require_draw_lifecycle_records() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'waiting_for_randomness' AND OLD.status IS DISTINCT FROM 'waiting_for_randomness'
    AND NOT EXISTS (SELECT 1 FROM drand_commitments WHERE round_id = NEW.id) THEN
    RAISE EXCEPTION 'A waiting round requires an immutable drand commitment';
  END IF;
  IF NEW.status = 'winner_selected' AND OLD.status IS DISTINCT FROM 'winner_selected'
    AND NOT EXISTS (SELECT 1 FROM draw_results WHERE round_id = NEW.id) THEN
    RAISE EXCEPTION 'A winner-selected round requires an immutable draw result';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER rounds_draw_lifecycle_records BEFORE UPDATE OF status ON rounds
FOR EACH ROW EXECUTE FUNCTION require_draw_lifecycle_records();

CREATE OR REPLACE FUNCTION prevent_drand_draw_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'drand commitments and draw results are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER drand_commitments_immutable BEFORE UPDATE OR DELETE ON drand_commitments FOR EACH ROW EXECUTE FUNCTION prevent_drand_draw_mutation();
CREATE TRIGGER draw_results_immutable BEFORE UPDATE OR DELETE ON draw_results FOR EACH ROW EXECUTE FUNCTION prevent_drand_draw_mutation();
