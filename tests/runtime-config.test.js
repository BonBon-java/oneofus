'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRuntimeConfiguration } = require('../runtime-config.js');

const base = { DATABASE_URL: 'postgresql://oneofus:local@127.0.0.1:5432/oneofus', ONE_OF_US_RECEIVING_ADDRESS: '0x1234567890abcdef1234567890abcdef12345678', ONE_OF_US_PAYMENT_MODE: 'local', ARBITRUM_RPC_URL: 'http://127.0.0.1:8545', ONE_OF_US_PAYMENT_TOKEN_ADDRESS: `0x${'1'.repeat(40)}` };

test('runtime configuration fails closed for malformed security-sensitive settings', () => {
  assert.equal(validateRuntimeConfiguration(base).chainId, 31337);
  assert.throws(() => validateRuntimeConfiguration({ ...base, PAYMENT_CONFIRMATIONS: '0' }), /between 1 and 1000/);
  assert.throws(() => validateRuntimeConfiguration({ ...base, PAYMENT_POLL_INTERVAL_MS: 'fast' }), /must be an integer/);
  assert.throws(() => validateRuntimeConfiguration({ ...base, DATABASE_URL: 'https://example.test' }), /PostgreSQL/);
  assert.throws(() => validateRuntimeConfiguration({ ...base, NODE_ENV: 'production', ONE_OF_US_PAYOUT_MODE: 'testnet' }), /forbidden/);
});

test('mainnet monitoring requires a configured HTTPS RPC endpoint', () => {
  const mainnet = { DATABASE_URL: base.DATABASE_URL, ONE_OF_US_RECEIVING_ADDRESS: base.ONE_OF_US_RECEIVING_ADDRESS, ARBITRUM_RPC_URL: 'https://arb1.example.test/rpc' };
  assert.equal(validateRuntimeConfiguration(mainnet).chainId, 42161);
  assert.throws(() => validateRuntimeConfiguration({ ...mainnet, ARBITRUM_RPC_URL: 'http://arb1.example.test/rpc' }), /HTTPS/);
});
