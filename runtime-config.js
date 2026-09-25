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
  if (target.chainId === 42161) {
    if (!env.ARBITRUM_RPC_URL) throw new Error('ARBITRUM_RPC_URL must be configured for mainnet payment monitoring.');
    const rpc = new URL(env.ARBITRUM_RPC_URL);
    if (rpc.protocol !== 'https:') throw new Error('Mainnet ARBITRUM_RPC_URL must use HTTPS.');
  }
  integerSetting(env, 'PAYMENT_RESERVATION_MINUTES', { minimum: 1, maximum: 1440 });
  integerSetting(env, 'PAYMENT_CODE_COOLDOWN_MINUTES', { minimum: 1, maximum: 10080 });
  integerSetting(env, 'PAYMENT_CONFIRMATIONS', { minimum: 1, maximum: 1000 });
  integerSetting(env, 'PAYMENT_POLL_INTERVAL_MS', { minimum: 1000, maximum: 300000 });
  integerSetting(env, 'ONE_OF_US_SCHEDULER_INTERVAL_MS', { minimum: 1000, maximum: 300000 });
  if (env.ONE_OF_US_PAYOUT_MODE) {
    if (env.NODE_ENV === 'production') throw new Error('Testnet payout execution is forbidden in production.');
    payoutTargetConfig(env);
  }
  return target;
}

module.exports = { validateRuntimeConfiguration };
