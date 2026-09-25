'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ResilientRpcClient } = require('../rpc-client.js');

test('retries a failed RPC request using its fallback endpoint without exposing it in errors', async () => {
  const seen = [];
  const client = new ResilientRpcClient({ urls: ['https://primary.example/rpc', 'https://fallback.example/rpc'], attempts: 2, fetchFunction: async (url) => {
    seen.push(url);
    if (url.includes('primary')) throw new Error('network unavailable');
    return { ok: true, status: 200, json: async () => ({ result: '0x1' }) };
  } });
  assert.equal(await client.call('eth_chainId', []), '0x1');
  assert.deepEqual(seen, ['https://primary.example/rpc', 'https://fallback.example/rpc']);
  assert.equal(client.status().ready, true);
});

test('fails closed after bounded retry attempts', async () => {
  const client = new ResilientRpcClient({ urls: ['https://primary.example/rpc'], attempts: 2, fetchFunction: async () => { throw new Error('offline'); } });
  await assert.rejects(client.call('eth_blockNumber', []), /failed after 2 attempts/);
});
