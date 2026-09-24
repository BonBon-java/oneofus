'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server.js');

async function withApi(run) {
  const service = { create: async () => ({ id: 'order', participant_id: 'participant', ticket_quantity: 1, base_ticket_amount: '1', expected_payment_amount: '1001000', payment_code: 1, sending_source: 'other', participant_name: 'Ada', payout_wallet: '0x1234567890abcdef1234567890abcdef12345678', expires_at: new Date(), payment_status: 'pending' }), publicOrder: (order) => order };
  const server = createServer({ repository: {}, service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('order API applies browser hardening headers and a bounded abuse limit', async () => {
  await withApi(async (baseUrl) => {
    const request = () => fetch(`${baseUrl}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tickets: 1 }) });
    const first = await request();
    assert.equal(first.status, 201);
    assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(first.headers.get('x-frame-options'), 'DENY');
    assert.match(first.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    for (let index = 0; index < 11; index += 1) assert.equal((await request()).status, 201);
    assert.equal((await request()).status, 429);
  });
});
