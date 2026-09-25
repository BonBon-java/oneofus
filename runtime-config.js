'use strict';

const { normalizeAddress } = require('./payment-domain.js');
const { paymentNetwork } = require('./payment-network.js');
const { payoutTargetConfig } = require('./payout-config.js');

function integerSetting(env, name, { minimum, maximum }) {
  const value = env[name];
  if (value === undefined || value === '') return;
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
}

function validateRuntimeConfiguration(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL must be configured before starting the payment API.');
  const database = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must use a PostgreSQL URL.');
  normalizeAddress(env.ONE_OF_US_RECEIVING_ADDRESS);
  const target = paymentNetwork(env);
  const environment = env.ONE_OF_US_ENV || (target.chainId === 31337 ? 'local' : 'production');
  if (!['local', 'staging', 'production'].includes(environment)) throw new Error('ONE_OF_US_ENV must be local, staging, or production.');
  if ((environment === 'local') !== (target.chainId === 31337)) throw new Error('Local environment requires local payment mode, and non-local environments must not use it.');
  if (environment === 'staging' && target.chainId !== 421614) throw new Error('Staging environment requires Arbitrum Sepolia payment mode.');
  if (environment === 'production' && target.chainId !== 42161) throw new Error('Production environment requires Arbitrum One payment mode.');
  if (target.chainId !== 31337) {
    if (!env.ARBITRUM_RPC_URL) throw new Error('ARBITRUM_RPC_URL must be configured for mainnet payment monitoring.');
    const rpc = new URL(env.ARBITRUM_RPC_URL);
    if (rpc.protocol !== 'https:') throw new Error('Non-local ARBITRUM_RPC_URL must use HTTPS.');
    if (env.ARBITRUM_RPC_FALLBACK_URL && new URL(env.ARBITRUM_RPC_FALLBACK_URL).protocol !== 'https:') throw new Error('Non-local ARBITRUM_RPC_FALLBACK_URL must use HTTPS.');
  }
  integerSetting(env, 'PAYMENT_RESERVATION_MINUTES', { minimum: 1, maximum: 1440 });
  integerSetting(env, 'PAYMENT_CODE_COOLDOWN_MINUTES', { minimum: 1, maximum: 10080 });
  integerSetting(env, 'PAYMENT_CONFIRMATIONS', { minimum: 1, maximum: 1000 });
  integerSetting(env, 'PAYMENT_POLL_INTERVAL_MS', { minimum: 1000, maximum: 300000 });
  integerSetting(env, 'ONE_OF_US_SCHEDULER_INTERVAL_MS', { minimum: 1000, maximum: 300000 });
  integerSetting(env, 'ONE_OF_US_RPC_TIMEOUT_MS', { minimum: 1000, maximum: 60000 });
  integerSetting(env, 'ONE_OF_US_RPC_ATTEMPTS', { minimum: 1, maximum: 5 });
  integerSetting(env, 'ONE_OF_US_SCAN_MAX_BLOCKS', { minimum: 1, maximum: 10000 });
  if (env.ONE_OF_US_PAYOUT_MODE) {
    if (env.NODE_ENV === 'production') throw new Error('Testnet payout execution is forbidden in production.');
    payoutTargetConfig(env);
  }
  return { ...target, environment, rpcUrls: [env.ARBITRUM_RPC_URL, env.ARBITRUM_RPC_FALLBACK_URL].filter(Boolean) };
}

module.exports = { validateRuntimeConfiguration };
