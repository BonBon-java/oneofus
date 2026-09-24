const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDrawSnapshotContent } = require('../postgres-repository.js');
const { DrawSnapshotService } = require('../draw-snapshot-service.js');

const round = (overrides = {}) => ({ id: 'round-1', paid_ticket_count: 10, free_ticket_count: 0, gross_pool_amount: '10000000', organizer_fee_amount: '0', winner_pool_amount: '10000000', carry_in_amount: '0', ...overrides });
const entry = (id, participantId, type, count, start, cause = 'payment_confirmation') => ({ ledger_entry_id: id, participant_id: participantId, payout_wallet: `0x${participantId.padEnd(40, '0')}`, payment_id: type === 'paid' ? `payment-${id}` : null, ticket_type: type, cause, ticket_count: count, source_start_ticket: start, source_end_ticket: String(BigInt(start) + BigInt(count) - 1n) });

test('creates a deterministic basic ten-paid-ticket snapshot and hash', () => {
  const snapshot = buildDrawSnapshotContent(round(), [entry('a', 'alice', 'paid', 10, '101')]);
  assert.equal(snapshot.totalEligibleTicketCount, 10);
  assert.equal(snapshot.ranges[0].startTicket, '1');
  assert.equal(snapshot.ranges[0].endTicket, '10');
  assert.match(snapshot.snapshotHash, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.snapshotHash, buildDrawSnapshotContent(round(), [entry('a', 'alice', 'paid', 10, '101')]).snapshotHash);
});

test('includes free tickets in eligibility but not in the monetary pool', () => {
  const snapshot = buildDrawSnapshotContent(round({ free_ticket_count: 4 }), [entry('paid', 'alice', 'paid', 10, '1'), entry('free', 'bob', 'free', 4, '20', 'referral_reward')]);
  assert.equal(snapshot.paidTicketCount, 10); assert.equal(snapshot.freeTicketCount, 4); assert.equal(snapshot.totalEligibleTicketCount, 14);
  assert.equal(snapshot.winnerPoolAmount, '10000000'); assert.equal(snapshot.totalWinnerEligibleAmount, '10000000');
  assert.deepEqual(snapshot.ranges.map(({ participantId, startTicket, endTicket }) => [participantId, startTicket, endTicket]), [['alice', '1', '10'], ['bob', '11', '14']]);
});

test('keeps a participant’s multiple source ranges distinct and ordered by ledger creation order', () => {
  const snapshot = buildDrawSnapshotContent(round(), [entry('first', 'alice', 'paid', 3, '100'), entry('middle', 'bob', 'paid', 5, '200'), entry('last', 'alice', 'paid', 2, '300')]);
  assert.deepEqual(snapshot.ranges.map(({ participantId, startTicket, endTicket }) => [participantId, startTicket, endTicket]), [['alice', '1', '3'], ['bob', '4', '8'], ['alice', '9', '10']]);
});

test('rejects underfilled rounds, mismatched ledger counts, and overlapping source ranges', () => {
  assert.throws(() => buildDrawSnapshotContent(round({ paid_ticket_count: 9 }), [entry('a', 'alice', 'paid', 9, '1')]), /at least 10/);
  assert.throws(() => buildDrawSnapshotContent(round(), [entry('a', 'alice', 'paid', 9, '1')]), /totals/);
  assert.throws(() => buildDrawSnapshotContent(round(), [entry('a', 'alice', 'paid', 5, '1'), entry('b', 'bob', 'paid', 5, '5')]), /overlap/);
});

test('draw snapshot service returns the repository’s existing immutable result on retry', async () => {
  const result = { id: 'snapshot', snapshotHash: 'a'.repeat(64), idempotent: true };
  const service = new DrawSnapshotService({ createDrawSnapshot: async () => result });
  assert.deepEqual(await service.createDrawSnapshot('round'), result);
});
