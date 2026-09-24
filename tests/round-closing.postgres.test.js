const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../db.js');
const { PostgresRepository } = require('../postgres-repository.js');

const databaseUrl = process.env.ROUND_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const id = () => crypto.randomUUID();

async function fixture(pool, { paidTickets = 9, freeTickets = 0, winnerPoolAmount = '9000000', conflictingSuccessor = false } = {}) {
  const participantId = id(); const roundId = id(); const orderId = id(); const paymentId = id();
  const ticketStart = Number(BigInt(`0x${id().replaceAll('-', '')}`) % 1_000_000_000n) + 1;
  const opensAt = new Date(Date.now() - 3 * 60 * 60 * 1000 - Math.floor(Math.random() * 60 * 60 * 1000));
  const closesAt = new Date(opensAt.getTime() + 60 * 60 * 1000);
  await pool.query(`INSERT INTO rounds (id,status,opens_at,closes_at,draw_at,carry_in_amount,gross_pool_amount,organizer_fee_amount,winner_pool_amount,paid_ticket_count,free_ticket_count) VALUES ($1,'open',$2,$3,$3,0,0,0,0,0,0)`, [roundId, opensAt, closesAt]);
  await pool.query('INSERT INTO participants (id,name,payout_wallet) VALUES ($1,$2,$3)', [participantId, 'Round test', `0x${id().replaceAll('-', '').padEnd(40, '0').slice(0, 40)}`]);
  await pool.query(`INSERT INTO orders (id,participant_id,round_id,ticket_quantity,sending_source,base_ticket_amount,ticket_value_amount,identification_amount,payment_code,expected_payment_amount,payment_status,created_at,expires_at,cooldown_until,paid_at) VALUES ($1,$2,$3,$4,'other',$5,$6,0,$7,$6,'paid',now(),now(),now(),now())`, [orderId, participantId, roundId, paidTickets, String(paidTickets), winnerPoolAmount, 1]);
  await pool.query(`INSERT INTO payments (id,order_id,transaction_hash,log_index,block_number,token_address,to_address,received_amount,detected_at,payment_status) VALUES ($1,$2,$3,0,1,$4,$5,$6,now(),'confirmed')`, [paymentId, orderId, `0x${id().replaceAll('-', '')}`, '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', `0x${'1'.repeat(40)}`, winnerPoolAmount]);
  await pool.query(`INSERT INTO ticket_ledger_entries (id,round_id,order_id,participant_id,payment_id,ticket_type,cause,ticket_count,start_ticket,end_ticket) VALUES ($1,$2,$3,$4,$5,'paid','test',$6,$7,$8)`, [id(), roundId, orderId, participantId, paymentId, paidTickets, ticketStart, ticketStart + paidTickets - 1]);
  if (freeTickets) await pool.query(`INSERT INTO ticket_ledger_entries (id,round_id,participant_id,ticket_type,cause,ticket_count,start_ticket,end_ticket) VALUES ($1,$2,$3,'free','test',$4,$5,$6)`, [id(), roundId, participantId, freeTickets, ticketStart + paidTickets, ticketStart + paidTickets + freeTickets - 1]);
  if (conflictingSuccessor) await pool.query(`INSERT INTO rounds (id,status,opens_at,closes_at,draw_at,carry_in_amount,gross_pool_amount,organizer_fee_amount,winner_pool_amount,paid_ticket_count,free_ticket_count) VALUES ($1,'open',$2::timestamptz,$2::timestamptz + interval '1 day',$2::timestamptz + interval '1 day',1,0,0,0,0,0)`, [id(), closesAt]);
  return { roundId, orderId, paymentId, participantId };
}

integration('PostgreSQL: rollover is idempotent and free tickets do not meet the threshold', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl }); await migrate(pool); t.after(() => pool.end());
  const row = await fixture(pool, { paidTickets: 9, freeTickets: 100 }); const repository = new PostgresRepository(pool);
  const [first, second] = await Promise.all([repository.closeRound(row.roundId), repository.closeRound(row.roundId)]);
  assert.equal(first.status, 'rolled_over'); assert.equal(first.paidTicketCount, 9); assert.equal(first.freeTicketCount, 100);
  assert.equal(second.nextRoundId, first.nextRoundId); assert.equal(second.carriedAmount, '9000000');
  const carry = await pool.query('SELECT amount FROM round_carry_overs WHERE from_round_id = $1', [row.roundId]);
  assert.deepEqual(carry.rows.map(({ amount }) => String(amount)), ['9000000']);
});

integration('PostgreSQL: ten paid tickets lock the round without a carry-over', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl }); await migrate(pool); t.after(() => pool.end());
  const row = await fixture(pool, { paidTickets: 10, winnerPoolAmount: '10000000' }); const result = await new PostgresRepository(pool).closeRound(row.roundId);
  assert.equal(result.status, 'locked'); assert.equal(result.nextRoundId, null); assert.equal(result.carriedAmount, '0');
  assert.equal((await pool.query('SELECT 1 FROM round_carry_overs WHERE from_round_id = $1', [row.roundId])).rowCount, 0);
});

integration('PostgreSQL: a locked round rejects direct ticket-ledger issuance', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl }); await migrate(pool); t.after(() => pool.end());
  const row = await fixture(pool, { paidTickets: 10 }); await new PostgresRepository(pool).closeRound(row.roundId);
  const start = Number(BigInt(`0x${id().replaceAll('-', '')}`) % 1_000_000_000n) + 1;
  await assert.rejects(pool.query(`INSERT INTO ticket_ledger_entries (id,round_id,participant_id,ticket_type,cause,ticket_count,start_ticket,end_ticket) VALUES ($1,$2,$3,'free','test',1,$4,$4)`, [id(), row.roundId, row.participantId, start]), /open round/);
});

integration('PostgreSQL: an error while attaching a successor rolls back the lock', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl }); await migrate(pool); t.after(() => pool.end());
  const row = await fixture(pool, { conflictingSuccessor: true }); const repository = new PostgresRepository(pool);
  await assert.rejects(repository.closeRound(row.roundId), /successor round/);
  assert.equal((await pool.query('SELECT status FROM rounds WHERE id = $1', [row.roundId])).rows[0].status, 'open');
});
