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

test('staging is pinned to Arbitrum Sepolia and cannot reuse the production token', () => {
  const staging = { DATABASE_URL: base.DATABASE_URL, ONE_OF_US_RECEIVING_ADDRESS: base.ONE_OF_US_RECEIVING_ADDRESS, ONE_OF_US_ENV: 'staging', ONE_OF_US_PAYMENT_MODE: 'staging', ARBITRUM_RPC_URL: 'https://sepolia.example.test/rpc', ONE_OF_US_PAYMENT_TOKEN_ADDRESS: `0x${'2'.repeat(40)}`, ARBITRUM_RPC_FALLBACK_URL: 'https://fallback.example.test/rpc' };
  const target = validateRuntimeConfiguration(staging);
  assert.equal(target.chainId, 421614);
  assert.deepEqual(target.rpcUrls, [staging.ARBITRUM_RPC_URL, staging.ARBITRUM_RPC_FALLBACK_URL]);
  assert.throws(() => validateRuntimeConfiguration({ ...staging, ONE_OF_US_PAYMENT_TOKEN_ADDRESS: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9' }), /non-production/);
  assert.throws(() => validateRuntimeConfiguration({ ...staging, ONE_OF_US_PAYMENT_TOKEN_ADDRESS: `0x${'0'.repeat(40)}` }), /non-zero/);
  assert.throws(() => validateRuntimeConfiguration({ ...staging, ONE_OF_US_ENV: 'production' }), /Production environment/);
});

test('production never accepts a testnet signer, and staging payout is bound to its inbound token', () => {
  const staging = { DATABASE_URL: base.DATABASE_URL, ONE_OF_US_RECEIVING_ADDRESS: base.ONE_OF_US_RECEIVING_ADDRESS, ONE_OF_US_ENV: 'staging', ONE_OF_US_PAYMENT_MODE: 'staging', ARBITRUM_RPC_URL: 'https://sepolia.example.test/rpc', ONE_OF_US_PAYMENT_TOKEN_ADDRESS: `0x${'2'.repeat(40)}`, ONE_OF_US_PAYOUT_MODE: 'testnet', ONE_OF_US_PAYOUT_RPC_URL: 'https://sepolia.example.test/rpc', ONE_OF_US_PAYOUT_CHAIN_ID: '421614', ONE_OF_US_PAYOUT_TOKEN_ADDRESS: `0x${'2'.repeat(40)}` };
  assert.equal(validateRuntimeConfiguration(staging).chainId, 421614);
  assert.throws(() => validateRuntimeConfiguration({ ...staging, ONE_OF_US_PAYOUT_TOKEN_ADDRESS: `0x${'3'.repeat(40)}` }), /must use the configured staging payment chain and token/);
  const production = { ...staging, ONE_OF_US_ENV: 'production', ONE_OF_US_PAYMENT_MODE: 'mainnet', ONE_OF_US_PAYOUT_MODE: 'testnet', ARBITRUM_RPC_URL: 'https://arb1.example.test/rpc' };
  assert.throws(() => validateRuntimeConfiguration(production), /forbidden in production/);
});

test('AWS KMS payout signing is explicit and confined to Arbitrum Sepolia staging', () => {
  const staging = {
    DATABASE_URL: base.DATABASE_URL, ONE_OF_US_RECEIVING_ADDRESS: base.ONE_OF_US_RECEIVING_ADDRESS,
    ONE_OF_US_ENV: 'staging', ONE_OF_US_PAYMENT_MODE: 'staging', ARBITRUM_RPC_URL: 'https://sepolia.example.test/rpc', ONE_OF_US_PAYMENT_TOKEN_ADDRESS: `0x${'2'.repeat(40)}`,
    ONE_OF_US_PAYOUT_MODE: 'testnet', ONE_OF_US_PAYOUT_RPC_URL: 'https://sepolia.example.test/rpc', ONE_OF_US_PAYOUT_CHAIN_ID: '421614', ONE_OF_US_PAYOUT_TOKEN_ADDRESS: `0x${'2'.repeat(40)}`,
    ONE_OF_US_PAYOUT_SIGNER_MODE: 'aws-kms', AWS_REGION: 'eu-north-1', AWS_KMS_KEY_ID: 'alias/oneofus-kms-smoke-test', AWS_KMS_EXPECTED_KEY_ARN: 'arn:aws:kms:eu-north-1:123456789012:key/test-key', PAYOUT_EXPECTED_SIGNER_ADDRESS: `0x${'3'.repeat(40)}`
  };
  assert.equal(validateRuntimeConfiguration(staging).payoutSigner.mode, 'staging-aws-kms');
  assert.throws(() => validateRuntimeConfiguration({ ...staging, AWS_KMS_EXPECTED_KEY_ARN: '' }), /AWS_KMS_EXPECTED_KEY_ARN/);
  assert.throws(() => validateRuntimeConfiguration({ ...staging, ONE_OF_US_PAYOUT_CHAIN_ID: '31337' }), /limited to Arbitrum Sepolia staging/);
});
