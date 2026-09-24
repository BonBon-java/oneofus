'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../db.js');
const { PostgresRepository } = require('../postgres-repository.js');

const databaseUrl = process.env.ROUND_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const id = () => crypto.randomUUID();

async function createRound(pool, opensAt) {
  const roundId = id(); const closesAt = new Date(opensAt.getTime() + 60 * 60 * 1000);
  await pool.query(`INSERT INTO rounds (id,status,opens_at,closes_at,draw_at,carry_in_amount,gross_pool_amount,organizer_fee_amount,winner_pool_amount,paid_ticket_count,free_ticket_count)
    VALUES ($1,'open',$2,$3,$3,0,0,0,0,0,0)`, [roundId, opensAt, closesAt]);
  return roundId;
}

async function addPaid(pool, roundId, participantId, count, start) {
  const orderId = id(); const paymentId = id(); const amount = String(count * 1_000_000);
  await pool.query(`INSERT INTO orders (id,participant_id,round_id,ticket_quantity,sending_source,base_ticket_amount,ticket_value_amount,identification_amount,payment_code,expected_payment_amount,payment_status,created_at,expires_at,cooldown_until,paid_at)
    VALUES ($1,$2,$3,$4,'other',$5,$6,0,$7,$6,'paid',now(),now(),now(),now())`, [orderId, participantId, roundId, count, String(count), amount, 1]);
  await pool.query(`INSERT INTO payments (id,order_id,transaction_hash,log_index,block_number,token_address,to_address,received_amount,detected_at,confirmed_at,payment_status)
    VALUES ($1,$2,$3,0,1,$4,$5,$6,now(),now(),'confirmed')`, [paymentId, orderId, `0x${id().replaceAll('-', '')}`, '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', `0x${'8'.repeat(40)}`, amount]);
  const ledgerId = id();
  await pool.query(`INSERT INTO ticket_ledger_entries (id,round_id,order_id,participant_id,payment_id,ticket_type,cause,ticket_count,start_ticket,end_ticket)
    VALUES ($1,$2,$3,$4,$5,'paid','rollover_test',$6,$7,$8)`, [ledgerId, roundId, orderId, participantId, paymentId, count, start, start + count - 1]);
  return ledgerId;
}

async function chain(pool, counts) {
  const repository = new PostgresRepository(pool); const participantId = id();
  await pool.query('INSERT INTO participants (id,name,payout_wallet) VALUES ($1,$2,$3)', [participantId, 'Rollover ticket owner', `0x${id().replaceAll('-', '').padEnd(40, '0').slice(0, 40)}`]);
  const opensAt = new Date(Date.now() - 12 * 60 * 60 * 1000 - Math.floor(Math.random() * 100_000));
  let roundId = await createRound(pool, opensAt); let ticket = 1_500_000_000 + Math.floor(Math.random() * 100_000_000); const ledgers = [];
  for (let index = 0; index < counts.length; index += 1) {
    ledgers.push(await addPaid(pool, roundId, participantId, counts[index], ticket)); ticket += counts[index];
    const closed = await repository.closeRound(roundId);
    if (index < counts.length - 1) { assert.equal(closed.status, 'rolled_over'); roundId = closed.nextRoundId; }
    else assert.equal(closed.status, 'locked');
  }
  return { repository, roundId, ledgers };
}

integration('PostgreSQL: a paid ticket survives rollover and retains its original round provenance', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl }); await migrate(pool); t.after(() => pool.end());
  const result = await chain(pool, [1, 9]); const snapshot = await result.repository.createDrawSnapshot(result.roundId);
  assert.equal(snapshot.paidTicketCount, 10);
  assert.deepEqual(new Set(snapshot.ranges.map((range) => range.ledgerEntryId)), new Set(result.ledgers));
  const first = snapshot.ranges.find((range) => range.ledgerEntryId === result.ledgers[0]);
  assert.ok(first.originRoundId);
  assert.notEqual(first.originRoundId, result.roundId);
});

integration('PostgreSQL: repeated rollovers accumulate tickets exactly once and do not leak into a later draw', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl }); await migrate(pool); t.after(() => pool.end());
  const result = await chain(pool, [7, 1, 1, 3]); const snapshot = await result.repository.createDrawSnapshot(result.roundId);
  assert.equal(snapshot.paidTicketCount, 12);
  assert.equal(snapshot.totalEligibleTicketCount, 12);
  assert.equal(new Set(snapshot.ranges.map((range) => range.ledgerEntryId)).size, 4);
  const laterRound = await createRound(pool, new Date(Date.now() + 48 * 60 * 60 * 1000 + Math.floor(Math.random() * 100_000)));
  const laterEligibility = await result.repository.eligibleLedgerEntries(pool, laterRound);
  assert.equal(laterEligibility.rowCount, 0);
});
