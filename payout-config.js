'use strict';

const { ethers } = require('ethers');
const { USDT_DECIMALS, USDT_TOKEN_ADDRESS } = require('./payment-domain.js');

// Local EVM is deliberately supported for repeatable, fund-free integration
// tests. Arbitrum Sepolia is the only public network allowed by this service.
const APPROVED_TEST_CHAIN_IDS = new Set([31337, 421614]);

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

module.exports = { APPROVED_TEST_CHAIN_IDS, payoutTargetConfig };
