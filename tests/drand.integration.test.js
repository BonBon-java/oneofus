const test = require('node:test');
const assert = require('node:assert/strict');
const { VerifiedDrandClient } = require('../drand.js');

const integration = process.env.RUN_DRAND_INTEGRATION === '1' ? test : test.skip;

integration('drand Quicknet verifies a fixed historical beacon round', async () => {
  const beacon = await new VerifiedDrandClient().fetchRound('42');
  assert.equal(beacon.round, 42);
  assert.match(beacon.randomness, /^[0-9a-f]{64}$/);
  assert.match(beacon.signature, /^[0-9a-f]+$/);
});
