const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../db.js');
const { PostgresRepository } = require('../postgres-repository.js');

const databaseUrl = process.env.ROUND_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const id = () => crypto.randomUUID();

async function readyFixture(pool, { freeTickets = 0, carryInAmount = '0', overlap = false } = {}) {
  const roundId = id(); const participantA = id(); const participantB = id(); const starts = Number(BigInt(`0x${id().replaceAll('-', '')}`) % 900_000_000n) + 1;
  const opensAt = new Date(Date.now() - 4 * 60 * 60 * 1000 - Math.floor(Math.random() * 60 * 60 * 1000)); const closesAt = new Date(opensAt.getTime() + 60 * 60 * 1000);
  await pool.query(`INSERT INTO rounds (id,status,opens_at,closes_at,draw_at,carry_in_amount,gross_pool_amount,organizer_fee_amount,winner_pool_amount,paid_ticket_count,free_ticket_count) VALUES ($1,'open',$2,$3,$3,$4,10000000,0,10000000,0,0)`, [roundId, opensAt, closesAt, carryInAmount]);
  for (const participant of [participantA, participantB]) await pool.query('INSERT INTO participants (id,name,payout_wallet) VALUES ($1,$2,$3)', [participant, participant, `0x${participant.replaceAll('-', '').padEnd(40, '0').slice(0, 40)}`]);
  let ledgerSequence = 0;
  const addPaid = async (participantId, count, start) => {
    const orderId = id(); const paymentId = id();
    await pool.query(`INSERT INTO orders (id,participant_id,round_id,ticket_quantity,sending_source,base_ticket_amount,ticket_value_amount,identification_amount,payment_code,expected_payment_amount,payment_status,created_at,expires_at,cooldown_until,paid_at) VALUES ($1,$2,$3,$4,'other',$5,$6,0,$7,$6,'paid',now(),now(),now(),now())`, [orderId, participantId, roundId, count, String(count), String(count * 1000000), 1]);
    await pool.query(`INSERT INTO payments (id,order_id,transaction_hash,log_index,block_number,token_address,to_address,received_amount,detected_at,payment_status) VALUES ($1,$2,$3,0,1,$4,$5,$6,now(),'confirmed')`, [paymentId, orderId, `0x${id().replaceAll('-', '')}`, '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', `0x${'2'.repeat(40)}`, String(count * 1000000)]);
    await pool.query(`INSERT INTO ticket_ledger_entries (id,round_id,order_id,participant_id,payment_id,ticket_type,cause,ticket_count,start_ticket,end_ticket,created_at) VALUES ($1,$2,$3,$4,$5,'paid','test',$6,$7,$8,$9)`, [id(), roundId, orderId, participantId, paymentId, count, start, start + count - 1, new Date(opensAt.getTime() + ++ledgerSequence)]);
  };
  await addPaid(participantA, 3, starts); await addPaid(participantB, 5, overlap ? starts + 2 : starts + 3); await addPaid(participantA, 2, starts + 8);
  if (freeTickets) await pool.query(`INSERT INTO ticket_ledger_entries (id,round_id,participant_id,ticket_type,cause,ticket_count,start_ticket,end_ticket,created_at) VALUES ($1,$2,$3,'free','referral_reward',$4,$5,$6,$7)`, [id(), roundId, participantB, freeTickets, starts + 20, starts + 19 + freeTickets, new Date(opensAt.getTime() + ++ledgerSequence)]);
  await pool.query("UPDATE rounds SET status = 'locked', paid_ticket_count = 10, free_ticket_count = $1 WHERE id = $2", [freeTickets, roundId]);
  return { roundId, participantA, participantB };
}

integration('PostgreSQL: snapshot is idempotent, includes free tickets, and preserves carry-in', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl }); await migrate(pool); t.after(() => pool.end());
  const row = await readyFixture(pool, { freeTickets: 4, carryInAmount: '7650000' }); const repository = new PostgresRepository(pool);
  const [first, second] = await Promise.all([repository.createDrawSnapshot(row.roundId), repository.createDrawSnapshot(row.roundId)]);
  assert.equal(first.id, second.id); assert.equal(first.snapshotHash, second.snapshotHash); assert.equal(first.totalEligibleTicketCount, 14);
  assert.equal(first.carryInAmount, '7650000'); assert.equal(first.totalWinnerEligibleAmount, '17650000');
  assert.deepEqual(first.ranges.map(({ startTicket, endTicket }) => [startTicket, endTicket]), [['1', '3'], ['4', '8'], ['9', '10'], ['11', '14']]);
  assert.equal((await pool.query('SELECT status FROM rounds WHERE id = $1', [row.roundId])).rows[0].status, 'waiting_for_randomness');
  await assert.rejects(pool.query('UPDATE draw_snapshots SET winner_pool_amount = 1 WHERE id = $1', [first.id]), /immutable/);
  await assert.rejects(pool.query(`INSERT INTO draw_snapshot_ranges (id,snapshot_id,sequence_number,ledger_entry_id,participant_id,payout_wallet,ticket_type,cause,start_ticket,end_ticket,source_start_ticket,source_end_ticket,ticket_count) VALUES ($1,$2,99,$3,$4,$5,'free','test',99,99,99,99,1)`, [id(), first.id, id(), row.participantA, `0x${'3'.repeat(40)}`]), /finalized/);
});

integration('PostgreSQL: overlapping ledger source ranges reject snapshot creation without changing round state', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl }); await migrate(pool); t.after(() => pool.end());
  const row = await readyFixture(pool, { overlap: true }); const repository = new PostgresRepository(pool);
  await assert.rejects(repository.createDrawSnapshot(row.roundId), /overlap/);
  assert.equal((await pool.query('SELECT status FROM rounds WHERE id = $1', [row.roundId])).rows[0].status, 'locked');
  assert.equal((await pool.query('SELECT 1 FROM draw_snapshots WHERE round_id = $1', [row.roundId])).rowCount, 0);
});
