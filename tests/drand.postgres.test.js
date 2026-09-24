const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../db.js');
const { PostgresRepository } = require('../postgres-repository.js');
const { drandCommitmentFor } = require('../drand.js');

const databaseUrl = process.env.ROUND_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const id = () => crypto.randomUUID();

async function waitingFixture(pool) {
  const roundId = id(); const snapshotId = id(); const participantId = id(); const rangeId = id();
  const opensAt = new Date(Date.now() - 4 * 60 * 60 * 1000); opensAt.setUTCMinutes(0, 0, 0); const closesAt = new Date(opensAt.getTime() + 60 * 60 * 1000);
  await pool.query(`INSERT INTO rounds (id,status,opens_at,closes_at,draw_at,carry_in_amount,gross_pool_amount,organizer_fee_amount,winner_pool_amount,paid_ticket_count,free_ticket_count) VALUES ($1,'open',$2,$3,$3,0,10000000,0,10000000,0,0)`, [roundId, opensAt, closesAt]);
  await pool.query('INSERT INTO participants (id,name,payout_wallet) VALUES ($1,$2,$3)', [participantId, 'drand test', `0x${participantId.replaceAll('-', '').padEnd(40, '0').slice(0, 40)}`]);
  const ledgerEntryId = id();
  await pool.query(`INSERT INTO ticket_ledger_entries (id,round_id,participant_id,ticket_type,cause,ticket_count,start_ticket,end_ticket) VALUES ($1,$2,$3,'free','test',1,1,1)`, [ledgerEntryId, roundId, participantId]);
  await pool.query("UPDATE rounds SET status = 'locked', paid_ticket_count = 10 WHERE id = $1", [roundId]);
  const finalizedAt = new Date(); const hash = crypto.createHash('sha256').update(snapshotId).digest('hex');
  await pool.query(`INSERT INTO draw_snapshots (id,round_id,snapshot_hash,paid_ticket_count,free_ticket_count,total_eligible_ticket_count,gross_pool_amount,organizer_fee_amount,winner_pool_amount,carry_in_amount,total_winner_eligible_amount,created_at) VALUES ($1,$2,$3,10,0,10,10000000,0,10000000,0,10000000,$4)`, [snapshotId, roundId, hash, finalizedAt]);
  await pool.query(`INSERT INTO draw_snapshot_ranges (origin_round_id, id,snapshot_id,sequence_number,ledger_entry_id,participant_id,payout_wallet,ticket_type,cause,start_ticket,end_ticket,source_start_ticket,source_end_ticket,ticket_count) VALUES ($6,$1,$2,1,$3,$4,$5,'paid','test',1,10,1,10,10)`, [rangeId, snapshotId, ledgerEntryId, participantId, `0x${participantId.replaceAll('-', '').padEnd(40, '0').slice(0, 40)}`, roundId]);
  const commitment = drandCommitmentFor(finalizedAt);
  await pool.query(`INSERT INTO drand_commitments (id,snapshot_id,round_id,snapshot_finalized_at,network_id,chain_hash,public_key,scheme_id,genesis_time,period_seconds,drand_round,scheduled_at,algorithm_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id(), snapshotId, roundId, finalizedAt, commitment.id, commitment.chainHash, commitment.publicKey, commitment.schemeId, commitment.genesisTime, commitment.periodSeconds, commitment.round, commitment.scheduledAt, commitment.algorithmVersion]);
  await pool.query("UPDATE rounds SET status = 'waiting_for_randomness' WHERE id = $1", [roundId]);
  return { roundId, drandRound: Number(commitment.round) };
}

integration('PostgreSQL: concurrent verified result recording creates one immutable winner', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl }); await migrate(pool); t.after(() => pool.end());
  const fixture = await waitingFixture(pool); const repository = new PostgresRepository(pool); const beacon = { round: fixture.drandRound, randomness: '00'.repeat(32), signature: 'ab'.repeat(48) };
  const [first, second] = await Promise.all([repository.recordVerifiedDrandResult(fixture.roundId, beacon), repository.recordVerifiedDrandResult(fixture.roundId, beacon)]);
  assert.equal(first.id, second.id); assert.equal(first.winningTicket, '1');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM draw_results WHERE round_id = $1', [fixture.roundId])).rows[0].count, 1);
});
