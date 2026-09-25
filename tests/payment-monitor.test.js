const test = require('node:test');
const assert = require('node:assert/strict');
const { ArbitrumPaymentMonitor } = require('../payment-monitor.js');

test('rescans a bounded history after restart and delegates duplicate safety to the repository', async () => {
  const calls = [];
  const repository = {
    getScannerBlock: async () => 100,
    setScannerBlock: async (_name, block) => calls.push(['cursor', block]),
    recordTransfer: async (log) => calls.push(['transfer', log.transactionHash]),
    pendingPaymentBlocks: async () => [100],
    confirmPayments: async (head, _confirmations, canonical) => calls.push(['confirm', head, canonical.get(100)]),
  };
  const monitor = new ArbitrumPaymentMonitor({ repository, service: { expirePending: async () => {} }, rpcUrl: 'http://rpc', receivingAddress: '0x1234567890abcdef1234567890abcdef12345678', fetchFunction: async () => ({}) });
  monitor.rpc = async (method) => {
    if (method === 'eth_blockNumber') return '0x70';
    if (method === 'eth_getBlockByNumber') return { hash: `0x${'a'.repeat(64)}` };
    return [{ transactionHash: `0x${'b'.repeat(64)}`, blockHash: `0x${'a'.repeat(64)}`, logIndex: '0x0', data: '0x1', blockNumber: '0x64', topics: [null, `0x${'0'.repeat(24)}${'1'.repeat(40)}`] }];
  };
  await monitor.scan();
  assert.equal(calls[0][0], 'transfer');
  assert.deepEqual(calls.at(-2), ['cursor', 112]);
  assert.deepEqual(calls.at(-1), ['confirm', 112, `0x${'a'.repeat(64)}`]);
});

test('does not finalize detected payments against a mismatched canonical block', async () => {
  const calls = [];
  const monitor = new ArbitrumPaymentMonitor({ repository: { pendingPaymentBlocks: async () => [25], confirmPayments: async (...args) => calls.push(args) }, service: {}, rpcUrl: 'http://rpc', receivingAddress: '0x1234567890abcdef1234567890abcdef12345678', fetchFunction: async () => ({}) });
  monitor.rpc = async (method) => method === 'eth_getBlockByNumber' ? { hash: `0x${'c'.repeat(64)}` } : null;
  await monitor.confirm(30);
  assert.equal(calls[0][2].get(25), `0x${'c'.repeat(64)}`);
});
