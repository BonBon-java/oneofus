'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectRpc } = require('../scripts/staging-smoke.js');

test('staging RPC smoke verifies chain, fresh head, token bytecode, logs, and optional receipt', async () => {
  const now = Math.floor(Date.now() / 1000).toString(16); const token = `0x${'2'.repeat(40)}`;
  const responses = { eth_chainId: '0x66eee', eth_blockNumber: '0x20', eth_getBlockByNumber: { hash: `0x${'a'.repeat(64)}`, timestamp: `0x${now}` }, eth_getCode: '0x6000', eth_getLogs: [], eth_getTransactionReceipt: { blockNumber: '0x1f', status: '0x1' } };
  const fetchFunction = async (_url, options) => { const request = JSON.parse(options.body); return { ok: true, json: async () => ({ result: responses[request.method] }) }; };
  const result = await inspectRpc('https://rpc.example.test', token, `0x${'b'.repeat(64)}`, fetchFunction);
  assert.equal(result.chainId, 421614); assert.equal(result.headBlock, 32); assert.equal(result.tokenCodeBytes, 2); assert.equal(result.transactionReceipt.status, '0x1');
});
