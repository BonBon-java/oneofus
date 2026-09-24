const test = require('node:test');
const assert = require('node:assert/strict');
const { amountFor, paymentAmountsFor, formatUnits, paymentIdentifierFor, paymentIdentifierFromAmount } = require('../payment-domain.js');
const { PaymentService } = require('../payment-service.js');
const { selectPaymentMatch } = require('../postgres-repository.js');

test('keeps exact USDT calculations in integer units', () => {
  assert.equal(amountFor(1, 1).toString(), '1001000');
  assert.equal(formatUnits(amountFor(3, 11)), '3.0012');
});

test('allocates increasing non-zero payment identifiers', () => {
  assert.equal(paymentIdentifierFor(1), '1');
  assert.equal(paymentIdentifierFor(9), '9');
  assert.equal(paymentIdentifierFor(10), '11');
  assert.equal(paymentIdentifierFor(11), '12');
});

test('identifies a payment solely by its non-zero fractional digits', () => {
  assert.equal(paymentIdentifierFromAmount('1012000'), '12'); // 1.012
  assert.equal(paymentIdentifierFromAmount('1000012'), '12'); // 1.000012
  assert.equal(paymentIdentifierFromAmount('1001200'), '12'); // 1.0012
  assert.equal(paymentIdentifierFromAmount('1000000'), '');
});

test('reserves the canonical amount and every supported zero-placement alias', () => {
  const reservations = paymentAmountsFor(3, 11);
  assert.equal(reservations.filter(({ kind }) => kind === 'exact').length, 1);
  assert.ok(reservations.some(({ amount, kind }) => kind === 'exact' && formatUnits(amount) === '3.0012'));
  assert.ok(reservations.some(({ amount, kind }) => kind === 'alias' && formatUnits(amount) === '3.012'));
  assert.equal(new Set(reservations.map(({ amount }) => amount.toString())).size, reservations.length);
});

test('an alias collision is visible before a second payment code is allocated', () => {
  const first = new Set(paymentAmountsFor(3, 11).map(({ amount }) => amount.toString()));
  // The canonical amount of this hypothetical second session is an alias of the first.
  const conflictingCanonical = '3012000';
  assert.equal(first.has(conflictingCanonical), true);
});

test('keeps the ticket price separate from the fractional identifier', () => {
  assert.equal((1000012n / 1000000n).toString(), '1');
  assert.equal((12n / 1000000n).toString(), '0');
  assert.equal(paymentIdentifierFromAmount('1000012'), paymentIdentifierFromAmount('12'));
});

test('an exact amount takes precedence over an alias', () => {
  const exact = { id: 'B', expected_payment_amount: '3012000' };
  const alias = { id: 'A', expected_payment_amount: '3001200' };
  assert.deepEqual(selectPaymentMatch([exact], [alias]), { order: exact, matchedBy: 'exact' });
  assert.deepEqual(selectPaymentMatch([], [alias]), { order: alias, matchedBy: 'alias' });
});

test('ambiguous aliases and unmatched amounts are never auto-credited', () => {
  assert.deepEqual(selectPaymentMatch([], [{ id: 'A' }, { id: 'B' }]), { manualReview: true, matchedBy: 'alias' });
  assert.equal(selectPaymentMatch([], []), null);
});

test('delegates a validated order to the PostgreSQL repository', async () => {
  let captured;
  const repository = { createOrder: async (data, participantId) => { captured = { data, participantId }; return { id: 'order', participant_id: 'participant', ticket_quantity: 1, base_ticket_amount: '1', expected_payment_amount: '1001000', payment_code: 1, sending_source: 'other', participant_name: 'Nikita', payout_wallet: '0x1234567890abcdef1234567890abcdef12345678', expires_at: new Date(), payment_status: 'pending' }; } };
  const service = new PaymentService(repository, '0x9c5dddc861b60b0dce772d9b0924c92e14d3bf02');
  const order = await service.create({ displayName: 'Nikita', source: 'other', tickets: 1, payoutWallet: '0x1234567890abcdef1234567890abcdef12345678', participantId: 'participant' });
  assert.equal(captured.participantId, 'participant');
  assert.equal(captured.data.ticketQuantity, 1);
  assert.equal(service.publicOrder(order).expectedAmount, '1.001');
});

test('SQL migrations define event idempotency and identifier reservations', () => {
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'migrations/001_initial.sql'), 'utf8');
  assert.match(sql, /UNIQUE \(transaction_hash, log_index\)/);
  assert.match(sql, /active_payment_amount_unique/);
  assert.match(sql, /ticket_ranges/);
  assert.match(sql, /scanner_state/);
  const aliasSql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'migrations/002_payment_amount_aliases.sql'), 'utf8');
  assert.match(aliasSql, /active_payment_amount_reservation_unique/);
  assert.match(aliasSql, /matched_by/);
  const identifierSql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'migrations/003_payment_identifiers.sql'), 'utf8');
  assert.match(identifierSql, /active_payment_identifier_reservation_unique/);
  const roundSql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'migrations/004_rounds_ticket_ledger.sql'), 'utf8');
  assert.match(roundSql, /CREATE TABLE IF NOT EXISTS rounds/);
  assert.match(roundSql, /ticket_ledger_entries/);
  assert.match(roundSql, /payments_transaction_hash_unique/);
  assert.match(roundSql, /at least 10 paid tickets/);
});
