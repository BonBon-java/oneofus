const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../payment-config.js');
const { getMinimumTickets } = require('../payment-sources.js');
const {
  ApiPaymentSessionService,
  PaymentDraft,
  createPaymentSessionService,
} = require('../payment-session.js');

test('uses Anonymous when the optional display name is empty', () => {
  const draft = new PaymentDraft();
  draft.setDisplayName('   ');
  assert.equal(draft.toRequest().displayName, 'Anonymous');
});

test('trims and limits a provided display name', () => {
  const draft = new PaymentDraft();
  draft.setDisplayName(`  ${'N'.repeat(40)}  `);
  assert.equal(draft.displayName, 'N'.repeat(28));
});

test('changing source raises tickets to its configured minimum', () => {
  const sources = [
    { id: 'one', enabled: true, minimumTickets: 1 },
    { id: 'three', enabled: true, minimumTickets: 3 },
  ];
  const draft = new PaymentDraft({ sources });
  draft.setSource('three');

  assert.equal(draft.minimumTickets, 3);
  assert.equal(draft.tickets, 3);
  assert.equal(draft.decrement(), 3);
});

test('normalizes missing or invalid source minimums to one ticket', () => {
  assert.equal(getMinimumTickets({ minimumTickets: null }), 1);
  assert.equal(getMinimumTickets({ minimumTickets: 0 }), 1);
  assert.equal(getMinimumTickets({ minimumTickets: 4 }), 4);
});

test('creates a clearly marked deterministic demo payment session', async () => {
  const service = createPaymentSessionService(config, {
    cryptoObject: { randomUUID: () => 'session-id' },
    random: () => 0.4279,
    now: () => Date.parse('2026-09-22T18:00:00.000Z'),
  });
  const session = await service.createPaymentSession({
    displayName: 'Nikita',
    source: 'bybit',
    tickets: 3,
  });

  assert.equal(session.sessionId, 'demo_session-id');
  assert.equal(session.baseAmount, '3.00');
  assert.equal(session.paymentSuffix, '0.00427');
  assert.equal(session.expectedAmount, '3.00427');
  assert.equal(session.displayName, 'Nikita');
  assert.equal(session.network, 'Arbitrum One');
  assert.equal(session.demo, true);
  assert.match(session.recipient, /DEMO/);
  assert.equal(session.expiresAt, '2026-09-22T18:15:00.000Z');
});

test('API mode refuses to create a session without backend configuration', async () => {
  const service = new ApiPaymentSessionService(
    { mode: 'api', sessionEndpoint: '', recipientAddress: '' },
    async () => ({ ok: true, json: async () => ({}) }),
  );

  await assert.rejects(service.createPaymentSession({ tickets: 1 }), { code: 'payment_unavailable' });
});
