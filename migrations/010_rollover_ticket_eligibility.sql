-- A snapshot records the immutable source round for every ticket.  A ticket
-- can therefore carry through underfilled rounds without rewriting its ledger.
ALTER TABLE draw_snapshot_ranges ADD COLUMN IF NOT EXISTS origin_round_id UUID REFERENCES rounds(id);
ALTER TABLE draw_snapshot_ranges DISABLE TRIGGER draw_snapshot_ranges_immutable;
UPDATE draw_snapshot_ranges r SET origin_round_id = l.round_id FROM ticket_ledger_entries l
WHERE l.id = r.ledger_entry_id AND r.origin_round_id IS NULL;
ALTER TABLE draw_snapshot_ranges ENABLE TRIGGER draw_snapshot_ranges_immutable;
ALTER TABLE draw_snapshot_ranges ALTER COLUMN origin_round_id SET NOT NULL;
