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

test('changing source keeps ticket selection so the UI can show its minimum warning', () => {
  const sources = [
    { id: 'one', enabled: true, minimumTickets: 1 },
    { id: 'three', enabled: true, minimumTickets: 3 },
  ];
  const draft = new PaymentDraft({ sources });
  draft.setSource('three');

  assert.equal(draft.minimumTickets, 3);
  assert.equal(draft.tickets, 1);
  assert.equal(draft.decrement(), 1);
});

test('keeps the payout wallet in the payment request and validates EVM format', () => {
  const draft = new PaymentDraft();
  draft.setPayoutWallet('0x1234567890abcdef1234567890ABCDEF12345678');
  assert.equal(draft.hasValidPayoutWallet(), true);
  assert.equal(draft.toRequest().payoutWallet, '0x1234567890abcdef1234567890ABCDEF12345678');
  draft.setPayoutWallet('0xnot-an-address');
  assert.equal(draft.hasValidPayoutWallet(), false);
});

test('can restore a previously entered name and wallet into a new draft', () => {
  const draft = new PaymentDraft();
  draft.setDisplayName('Nikita');
  draft.setPayoutWallet('0x1234567890abcdef1234567890abcdef12345678');
  assert.equal(draft.toRequest().displayName, 'Nikita');
  assert.equal(draft.toRequest().payoutWallet, '0x1234567890abcdef1234567890abcdef12345678');
});

test('normalizes missing or invalid source minimums to one ticket', () => {
  assert.equal(getMinimumTickets({ minimumTickets: null }), 1);
  assert.equal(getMinimumTickets({ minimumTickets: 0 }), 1);
  assert.equal(getMinimumTickets({ minimumTickets: 4 }), 4);
});

test('API mode refuses to create a session without a backend endpoint', async () => {
  const service = new ApiPaymentSessionService(
    { mode: 'api', sessionEndpoint: '', recipientAddress: '' },
    async () => ({ ok: true, json: async () => ({}) }),
  );

  await assert.rejects(service.createPaymentSession({ tickets: 1 }), { code: 'payment_unavailable' });
});

test('API mode sends the draft to the server and uses its order response', async () => {
  let request;
  const service = new ApiPaymentSessionService({ mode: 'api', sessionEndpoint: '/api/orders' }, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ orderId: 'order-id', expectedAmount: '3.0174' }) };
  });
  const session = await service.createPaymentSession({ tickets: 3 });
  assert.equal(request.url, '/api/orders');
  assert.equal(JSON.parse(request.options.body).tickets, 3);
  assert.equal(session.expectedAmount, '3.0174');
});
