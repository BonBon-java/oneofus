'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server.js');

const roundId = 'a3f1c8d2-7b54-4c9e-9a6d-1f2e3b4c5d6e';
const publicRandomness = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const transactionHash = `0x${'ab'.repeat(32)}`;

function verified(overrides = {}) {
  return {
    status: 'verified', roundId, roundState: 'completed', entriesLockedAt: '2026-09-20T00:00:00.000Z', drawnAt: '2026-09-20T00:00:03.000Z', totalEligibleTickets: 42, paidTicketCount: 40, freeTicketCount: 2, snapshotHash: 'f'.repeat(64),
    drand: { network: 'quicknet', chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971', round: '12345678', scheduledAt: '2026-09-20T00:00:03.000Z' },
    publicRandomness, algorithmVersion: 'ONE_OF_US_DRAND_V1', winningTicket: '17', winnerWallet: '0x1111111111111111111111111111111111111111', prizeAmount: '35700000', payout: { status: 'pending', transactionHash: null }, ...overrides,
  };
}

async function withApi(verifyDraw, run) {
  const server = createServer({ repository: { verifyDraw }, service: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function request(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { response, body: await response.json() };
}

function assertPublic(body) {
  const serialized = JSON.stringify(body).toLowerCase();
  for (const forbidden of ['private_key', 'privatekey', 'signer', 'worker_id', 'database_url', 'password', 'stack', 'secret']) assert.equal(serialized.includes(forbidden), false, `response exposed ${forbidden}`);
}

test('Verify Draw HTTP API returns the complete immutable payload for a completed draw', async () => {
  await withApi(async () => verified(), async (baseUrl) => {
    const { response, body } = await request(baseUrl, `/api/draws/${roundId}/verify`);
    assert.equal(response.status, 200);
    assert.deepEqual(body, verified());
    assertPublic(body);
  });
});

test('Verify Draw HTTP API safely reports a missing or malformed public round identifier', async () => {
  await withApi(async () => null, async (baseUrl) => {
    const missing = await request(baseUrl, `/api/draws/${roundId}/verify`);
    assert.equal(missing.response.status, 404);
    assert.deepEqual(missing.body, { error: 'Draw not found.' });
    const malformed = await request(baseUrl, '/api/draws/not-a-uuid/verify');
    assert.equal(malformed.response.status, 404);
    assert.deepEqual(malformed.body, { error: 'Not found.' });
    assertPublic(missing.body); assertPublic(malformed.body);
  });
});

test('Verify Draw HTTP API reports incomplete and legacy draws without invented randomness or tickets', async () => {
  for (const verification of [
    { roundId, status: 'unavailable', reason: 'snapshot_not_available' },
    { roundId, status: 'unavailable', reason: 'verification_not_available' },
  ]) {
    await withApi(async () => verification, async (baseUrl) => {
      const { response, body } = await request(baseUrl, `/api/draws/${roundId}/verify`);
      assert.equal(response.status, 200);
      assert.deepEqual(body, verification);
      assert.equal('winningTicket' in body, false);
      assert.equal('publicRandomness' in body, false);
      assert.equal('drand' in body, false);
      assertPublic(body);
    });
  }
});

test('Verify Draw HTTP API exposes pending payout without a transaction hash', async () => {
  await withApi(async () => verified(), async (baseUrl) => {
    const { response, body } = await request(baseUrl, `/api/draws/${roundId}/verify`);
    assert.equal(response.status, 200);
    assert.equal(body.status, 'verified');
    assert.deepEqual(body.payout, { status: 'pending', transactionHash: null });
    assert.equal(body.winningTicket, '17');
    assertPublic(body);
  });
});

test('Verify Draw HTTP API exposes a confirmed public payout transaction hash', async () => {
  await withApi(async () => verified({ payout: { status: 'confirmed', transactionHash } }), async (baseUrl) => {
    const { response, body } = await request(baseUrl, `/api/draws/${roundId}/verify`);
    assert.equal(response.status, 200);
    assert.deepEqual(body.payout, { status: 'confirmed', transactionHash });
    assertPublic(body);
  });
});

test('Verify Draw HTTP API does not leak internal errors or environment values', async () => {
  const internalMessage = 'DATABASE_URL=postgres://user:password@example.test/oneofus private_key=do-not-expose';
  await withApi(async () => { throw new Error(internalMessage); }, async (baseUrl) => {
    const { response, body } = await request(baseUrl, `/api/draws/${roundId}/verify`);
    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: 'Invalid request.' });
    assert.equal(JSON.stringify(body).includes(internalMessage), false);
    assertPublic(body);
  });
});
