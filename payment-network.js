'use strict';
const { ARBITRUM_CHAIN_ID, USDT_TOKEN_ADDRESS, normalizeAddress } = require('./payment-domain.js');
function paymentNetwork(env = process.env) {
  if (!env.ONE_OF_US_PAYMENT_MODE || env.ONE_OF_US_PAYMENT_MODE === 'mainnet') return { chainId: ARBITRUM_CHAIN_ID, tokenAddress: USDT_TOKEN_ADDRESS, network: 'Arbitrum One', scannerName: 'arbitrum-usdt' };
  if (env.ONE_OF_US_PAYMENT_MODE === 'staging') {
    const rpc = new URL(env.ARBITRUM_RPC_URL); const tokenAddress = normalizeAddress(env.ONE_OF_US_PAYMENT_TOKEN_ADDRESS);
    if (rpc.protocol !== 'https:' || tokenAddress === USDT_TOKEN_ADDRESS.toLowerCase()) throw new Error('Staging payments require HTTPS RPC and a non-production 6-decimal test token.');
    return { chainId: 421614, tokenAddress, network: 'Arbitrum Sepolia', scannerName: `staging-usdt-${tokenAddress}` };
  }
  if (env.ONE_OF_US_PAYMENT_MODE !== 'local') throw new Error('Unsupported payment mode.');
  const rpc = new URL(env.ARBITRUM_RPC_URL);
  const tokenAddress = normalizeAddress(env.ONE_OF_US_PAYMENT_TOKEN_ADDRESS);
  if (rpc.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname) || tokenAddress === USDT_TOKEN_ADDRESS.toLowerCase() || tokenAddress === `0x${'0'.repeat(40)}`) throw new Error('Local payments require a loopback RPC and a non-production MockUSDT token.');
  return { chainId: 31337, tokenAddress, network: 'Local MockUSDT (test only)', scannerName: `local-usdt-${tokenAddress}` };
}
module.exports = { paymentNetwork };
