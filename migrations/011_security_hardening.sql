-- Security invariants that must also hold under concurrent workers.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS block_hash TEXT;
ALTER TABLE payments ADD CONSTRAINT payments_block_hash_format CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$');

CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE ticket_ranges ADD CONSTRAINT ticket_ranges_no_overlap
  EXCLUDE USING gist (int8range(start_ticket, end_ticket, '[]') WITH &&);
ALTER TABLE ticket_ledger_entries ADD CONSTRAINT ticket_ledger_entries_no_overlap
  EXCLUDE USING gist (int8range(start_ticket, end_ticket, '[]') WITH &&);
