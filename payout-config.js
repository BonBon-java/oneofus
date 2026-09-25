'use strict';

const { ethers } = require('ethers');
const { USDT_DECIMALS, USDT_TOKEN_ADDRESS } = require('./payment-domain.js');

// Local EVM is deliberately supported for repeatable, fund-free integration
// tests. Arbitrum Sepolia is the only public network allowed by this service.
const APPROVED_TEST_CHAIN_IDS = new Set([31337, 421614]);

function productionSignerConfig(env = process.env) {
  const rawKeyVariables = ['ONE_OF_US_PAYOUT_PRIVATE_KEY', 'PRIVATE_KEY', 'PAYOUT_PRIVATE_KEY'];
  if (rawKeyVariables.some((name) => env[name])) throw new Error('Raw private-key payout configuration is forbidden in production.');
  const enabled = env.PAYOUT_ENABLED === 'true';
  const mode = env.PAYOUT_SIGNER_MODE || 'disabled';
  if (!enabled) return { mode: 'disabled', enabled: false };
  if (mode !== 'production-external') throw new Error('Production payout requires PAYOUT_SIGNER_MODE=production-external.');
  if (!env.PAYOUT_EXPECTED_SIGNER_ADDRESS) throw new Error('PAYOUT_EXPECTED_SIGNER_ADDRESS is required when production payout is enabled.');
  if (!env.PAYOUT_SIGNER_URL || !env.PAYOUT_SIGNER_AUTH_TOKEN) throw new Error('Production payout requires an isolated signer URL and credential.');
  if (!env.PAYOUT_TREASURY_ADDRESS) throw new Error('PAYOUT_TREASURY_ADDRESS is required when production payout is enabled.');
  const expectedAddress = ethers.getAddress(env.PAYOUT_EXPECTED_SIGNER_ADDRESS); if (expectedAddress === ethers.ZeroAddress) throw new Error('PAYOUT_EXPECTED_SIGNER_ADDRESS must not be the zero address.');
  for (const name of ['MAX_SINGLE_PAYOUT_BASE_UNITS', 'MIN_GAS_BALANCE_WEI']) if (!/^[1-9][0-9]*$/.test(env[name] || '')) throw new Error(`${name} must be a positive integer when production payout is enabled.`);
  const treasuryAddress = ethers.getAddress(env.PAYOUT_TREASURY_ADDRESS); if (treasuryAddress === ethers.ZeroAddress) throw new Error('PAYOUT_TREASURY_ADDRESS must not be the zero address.');
  if (!env.AWS_KMS_KEY_ID || !env.AWS_REGION) throw new Error('Production payout requires explicit AWS_KMS_KEY_ID and AWS_REGION.');
  return { mode, enabled: true, expectedAddress, treasuryAddress, url: env.PAYOUT_SIGNER_URL, kmsKeyId: env.AWS_KMS_KEY_ID, awsRegion: env.AWS_REGION, maxSinglePayoutBaseUnits: env.MAX_SINGLE_PAYOUT_BASE_UNITS, minGasBalanceWei: env.MIN_GAS_BALANCE_WEI };
}

function payoutTargetConfig(env = process.env) {
  if (env.ONE_OF_US_PAYOUT_MODE !== 'testnet') throw new Error('Payout execution is disabled. Set ONE_OF_US_PAYOUT_MODE=testnet only for an approved test environment.');
  if (!env.ONE_OF_US_PAYOUT_RPC_URL) throw new Error('ONE_OF_US_PAYOUT_RPC_URL must be configured for testnet payout execution.');
  if (!env.ONE_OF_US_PAYOUT_CHAIN_ID || !/^[0-9]+$/.test(env.ONE_OF_US_PAYOUT_CHAIN_ID)) throw new Error('ONE_OF_US_PAYOUT_CHAIN_ID must be a configured approved test chain ID.');
  const chainId = Number(env.ONE_OF_US_PAYOUT_CHAIN_ID);
  if (!APPROVED_TEST_CHAIN_IDS.has(chainId)) throw new Error('Payout execution is limited to approved test networks.');
  if (!env.ONE_OF_US_PAYOUT_TOKEN_ADDRESS) throw new Error('ONE_OF_US_PAYOUT_TOKEN_ADDRESS must identify MockUSDT on the test network.');
  const tokenAddress = ethers.getAddress(env.ONE_OF_US_PAYOUT_TOKEN_ADDRESS);
  if (tokenAddress.toLowerCase() === USDT_TOKEN_ADDRESS.toLowerCase()) throw new Error('Production USDT is never an allowed payout token in testnet mode.');
  const decimals = env.ONE_OF_US_PAYOUT_TOKEN_DECIMALS === undefined ? USDT_DECIMALS : Number(env.ONE_OF_US_PAYOUT_TOKEN_DECIMALS);
  if (decimals !== USDT_DECIMALS) throw new Error(`Test payout token must use ${USDT_DECIMALS} decimals.`);
  return { mode: 'testnet', rpcUrl: env.ONE_OF_US_PAYOUT_RPC_URL, chainId, tokenAddress, decimals };
}

module.exports = { APPROVED_TEST_CHAIN_IDS, payoutTargetConfig, productionSignerConfig };
