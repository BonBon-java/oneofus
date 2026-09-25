'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { productionSignerConfig } = require('../payout-config.js');
const { ExternalPayoutSigner } = require('../payout-signer.js');

const address = '0x1111111111111111111111111111111111111111';
test('production signer remains disabled by default and rejects raw private key material', () => {
  assert.deepEqual(productionSignerConfig({}), { mode: 'disabled', enabled: false });
  assert.throws(() => productionSignerConfig({ ONE_OF_US_PAYOUT_PRIVATE_KEY: '0xabc' }), /forbidden/);
  assert.throws(() => productionSignerConfig({ PAYOUT_ENABLED: 'true', PAYOUT_SIGNER_MODE: 'staging-raw-key' }), /production-external/);
});
test('production signer requires an expected identity and isolated signer configuration', () => {
  assert.throws(() => productionSignerConfig({ PAYOUT_ENABLED: 'true', PAYOUT_SIGNER_MODE: 'production-external' }), /EXPECTED_SIGNER/);
  assert.throws(() => productionSignerConfig({ PAYOUT_ENABLED: 'true', PAYOUT_SIGNER_MODE: 'production-external', PAYOUT_EXPECTED_SIGNER_ADDRESS: address }), /isolated signer/);
  assert.throws(() => productionSignerConfig({ PAYOUT_ENABLED: 'true', PAYOUT_SIGNER_MODE: 'production-external', PAYOUT_EXPECTED_SIGNER_ADDRESS: '0x0000000000000000000000000000000000000000', PAYOUT_SIGNER_URL: 'https://signer.example', PAYOUT_SIGNER_AUTH_TOKEN: 'token' }), /zero address/);
  assert.throws(() => productionSignerConfig({ PAYOUT_ENABLED: 'true', PAYOUT_SIGNER_MODE: 'production-external', PAYOUT_EXPECTED_SIGNER_ADDRESS: address, PAYOUT_SIGNER_URL: 'https://signer.example', PAYOUT_SIGNER_AUTH_TOKEN: 'token' }), /MAX_SINGLE/);
});
test('external signer accepts only its configured identity and payout-shaped requests', async () => {
  const calls = []; const client = { identity: async () => ({ address }), prepareErc20Transfer: async (intent) => { calls.push(intent); return { requestId: 'kms-request' }; }, broadcastPreparedTransfer: async () => ({ transactionHash: '0xabc' }) };
  const signer = new ExternalPayoutSigner({ expectedAddress: address, client });
  assert.equal((await signer.identity()).address, address);
  await signer.prepareApprovedTransfer({ id: 'intent', chainId: 42161, tokenAddress: '0x2222222222222222222222222222222222222222', winnerWallet: '0x3333333333333333333333333333333333333333', winnerAmount: '1000000' });
  assert.deepEqual(calls[0], { payoutIntentId: 'intent', chainId: 42161, tokenAddress: '0x2222222222222222222222222222222222222222', recipient: '0x3333333333333333333333333333333333333333', amount: '1000000' });
  const wrong = new ExternalPayoutSigner({ expectedAddress: address, client: { ...client, identity: async () => ({ address: '0x2222222222222222222222222222222222222222' }) } });
  await assert.rejects(wrong.identity(), /does not match/);
});
