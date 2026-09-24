'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentNetwork } = require('../payment-network.js');
const { USDT_TOKEN_ADDRESS } = require('../payment-domain.js');
test('local incoming payment configuration cannot silently select a public network or production token', () => {
  assert.equal(paymentNetwork({}).chainId, 42161);
  const local = { ONE_OF_US_PAYMENT_MODE: 'local', ARBITRUM_RPC_URL: 'http://127.0.0.1:8545', ONE_OF_US_PAYMENT_TOKEN_ADDRESS: `0x${'1'.repeat(40)}` };
  assert.equal(paymentNetwork(local).chainId, 31337);
  assert.throws(() => paymentNetwork({ ...local, ARBITRUM_RPC_URL: 'https://public.example' }), /loopback/);
  assert.throws(() => paymentNetwork({ ...local, ONE_OF_US_PAYMENT_TOKEN_ADDRESS: USDT_TOKEN_ADDRESS }), /MockUSDT/);
  assert.throws(() => paymentNetwork({ ...local, ONE_OF_US_PAYMENT_MODE: 'testnet' }), /Unsupported/);
});
