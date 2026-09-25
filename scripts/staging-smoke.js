'use strict';

const { performance } = require('node:perf_hooks');
const { normalizeAddress } = require('../payment-domain.js');

const CHAIN_ID = 421614;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = (number) => `0x${Number(number).toString(16)}`;

async function rpc(url, method, params = [], fetchFunction = fetch) {
  const started = performance.now();
  const response = await fetchFunction(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(Number(process.env.ONE_OF_US_RPC_TIMEOUT_MS || 10_000)) });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return { result: body.result, latencyMs: Math.round(performance.now() - started) };
}

async function inspectRpc(url, tokenAddress, transactionHash, fetchFunction) {
  const chain = await rpc(url, 'eth_chainId', [], fetchFunction);
  if (Number.parseInt(chain.result, 16) !== CHAIN_ID) throw new Error(`wrong chain ID ${chain.result}`);
  const head = await rpc(url, 'eth_blockNumber', [], fetchFunction); const headNumber = Number.parseInt(head.result, 16);
  const block = await rpc(url, 'eth_getBlockByNumber', [head.result, false], fetchFunction); const ageSeconds = Math.floor(Date.now() / 1000) - Number.parseInt(block.result?.timestamp || '0x0', 16);
  if (!block.result?.hash || ageSeconds > 300) throw new Error(`stale or invalid head block (age ${ageSeconds}s)`);
  const code = await rpc(url, 'eth_getCode', [tokenAddress, 'latest'], fetchFunction); if (code.result === '0x') throw new Error('configured token has no deployed bytecode');
  const logs = await rpc(url, 'eth_getLogs', [{ address: tokenAddress, fromBlock: hex(Math.max(0, headNumber - 1)), toBlock: head.result, topics: [TRANSFER_TOPIC] }], fetchFunction);
  const receipt = transactionHash ? await rpc(url, 'eth_getTransactionReceipt', [transactionHash], fetchFunction) : null;
  return { url, chainId: CHAIN_ID, headBlock: headNumber, headTimestamp: Number.parseInt(block.result.timestamp, 16), headAgeSeconds: ageSeconds, tokenCodeBytes: (code.result.length - 2) / 2, recentTransferLogCount: logs.result.length, transactionReceipt: receipt?.result ? { blockNumber: Number.parseInt(receipt.result.blockNumber, 16), status: receipt.result.status } : null, latencyMs: { chainId: chain.latencyMs, blockNumber: head.latencyMs, block: block.latencyMs, code: code.latencyMs, logs: logs.latencyMs, receipt: receipt?.latencyMs ?? null } };
}

async function checkApi(apiUrl, fetchFunction = fetch) {
  if (!apiUrl) return null;
  const base = apiUrl.replace(/\/$/, '');
  const result = {};
  for (const path of ['/healthz', '/readyz']) { const response = await fetchFunction(`${base}${path}`, { signal: AbortSignal.timeout(10_000) }); result[path] = { status: response.status, body: await response.json() }; }
  if (result['/healthz'].status !== 200 || result['/readyz'].status !== 200 || !result['/readyz'].body.ready) throw new Error('staging API is not ready');
  return result;
}

async function main({ env = process.env, fetchFunction = fetch } = {}) {
  if (!env.ARBITRUM_RPC_URL) throw new Error('ARBITRUM_RPC_URL is required.');
  const tokenAddress = normalizeAddress(env.ONE_OF_US_PAYMENT_TOKEN_ADDRESS);
  const urls = [env.ARBITRUM_RPC_URL, env.ARBITRUM_RPC_FALLBACK_URL].filter(Boolean);
  const endpoints = [];
  for (const url of urls) { try { endpoints.push({ ok: true, ...(await inspectRpc(url, tokenAddress, env.STAGING_TRANSACTION_HASH, fetchFunction)) }); } catch (error) { endpoints.push({ ok: false, url, error: error.message }); } }
  if (!endpoints.some((endpoint) => endpoint.ok)) throw new Error('No configured staging RPC endpoint passed smoke checks.');
  const api = await checkApi(env.STAGING_API_URL, fetchFunction);
  return { checkedAt: new Date().toISOString(), endpoints, api };
}

if (require.main === module) main().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(`Staging smoke failed: ${error.message}`); process.exitCode = 1; });
module.exports = { CHAIN_ID, rpc, inspectRpc, checkApi, main };
