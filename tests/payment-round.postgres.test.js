'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../db.js');
const { PostgresRepository } = require('../postgres-repository.js');
const { PaymentService } = require('../payment-service.js');
const { USDT_TOKEN_ADDRESS } = require('../payment-domain.js');

test('payments across UTC close: rollover visibility, ledger provenance, late confirmation and threshold', { skip: !process.env.ROUND_TEST_DATABASE_URL }, async (t) => {
  const pool = new Pool({ connectionString: process.env.ROUND_TEST_DATABASE_URL });
  t.after(() => pool.end()); await migrate(pool);
  const repository = new PostgresRepository(pool);
  const receivingAddress = `0x${'1'.repeat(40)}`;
  const service = new PaymentService(repository, receivingAddress);
  const input = { payoutWallet: `0x${crypto.randomBytes(20).toString('hex')}`, tickets: 2, source: 'other' };
  const first = await service.create(input);
  async function detect(order) {
    return repository.recordTransfer({ transactionHash: `0x${crypto.randomBytes(32).toString('hex')}`, blockHash: `0x${crypto.randomBytes(32).toString('hex')}`, logIndex: '0x0', blockNumber: '0xa', data: `0x${BigInt(order.expected_payment_amount).toString(16)}`, topics: [null, `0x${'1'.repeat(40).padStart(64, '0')}`] }, { tokenAddress: USDT_TOKEN_ADDRESS, receivingAddress });
  }
  await detect(first); await repository.confirmPayments(12, 3);
  const pending = await service.create({ ...input, tickets: 8, participantId: first.participant_id });
  const delayed = await service.create({ ...input, tickets: 1 });
  await detect(pending);
  const boundary = new Date(); boundary.setUTCHours(0, 0, 0, 0);
  await pool.query('UPDATE rounds SET opens_at=$1,closes_at=$2,draw_at=$2 WHERE id=$3', [new Date(boundary.getTime() - 86400000), boundary, first.round_id]);
  await pool.query("UPDATE orders SET paid_at=$1 WHERE id=$2", [new Date(boundary.getTime() - 1000), first.id]);
  // Confirmation must create today's round even if the scheduler has not closed yesterday yet.
  await repository.confirmPayments(12, 3);
  const paid = await repository.getOrder(pending.id);
  assert.notEqual(paid.round_id, first.round_id);
  const closed = await repository.closeRound(first.round_id);
  assert.equal(closed.status, 'rolled_over'); assert.equal(closed.carriedAmount, '2000000');
  assert.equal(closed.nextRoundId, paid.round_id);
  assert.equal((await repository.getOrder(first.id)).round_id, first.round_id);
  const entry = await repository.participantEntries(first.participant_id);
  assert.equal(entry.tickets, 10, 'carried tickets must remain visible after the UTC boundary');
  const site = await repository.siteSummary();
  assert.equal(site.currentPool.paidTickets, 10); assert.equal(site.currentPool.amount, '10');
  await detect(delayed); await repository.confirmPayments(12, 3);
  assert.equal((await repository.getOrder(delayed.id)).round_id, paid.round_id);
  const newOrder = await service.create(input);
  assert.equal(newOrder.round_id, paid.round_id, 'new payments after rollover use the active round');
  const current = await repository.closeRound(paid.round_id);
  assert.equal(current.status, 'locked'); assert.equal(current.paidTicketCount, 11);
  const snapshot = await repository.createDrawSnapshot(paid.round_id);
  assert.equal(snapshot.totalWinnerEligibleAmount, '11000000');
  assert.deepEqual(snapshot.ranges.map((range) => range.originRoundId), [first.round_id, paid.round_id, paid.round_id]);
});
