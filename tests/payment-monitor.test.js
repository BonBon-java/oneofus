const test = require('node:test');
const assert = require('node:assert/strict');
const { ArbitrumPaymentMonitor } = require('../payment-monitor.js');

test('rescans a bounded history after restart and delegates duplicate safety to the repository', async () => {
  const calls = [];
  const repository = {
    getScannerBlock: async () => 100,
    setScannerBlock: async (_name, block) => calls.push(['cursor', block]),
    recordTransfer: async (log) => calls.push(['transfer', log.transactionHash]),
    confirmPayments: async (head) => calls.push(['confirm', head]),
  };
  const monitor = new ArbitrumPaymentMonitor({ repository, service: { expirePending: async () => {} }, rpcUrl: 'http://rpc', receivingAddress: '0x1234567890abcdef1234567890abcdef12345678', fetchFunction: async () => ({}) });
  monitor.rpc = async (method) => method === 'eth_blockNumber' ? '0x70' : [{ transactionHash: '0xrepeat', logIndex: '0x0', data: '0x1', blockNumber: '0x64', topics: [] }];
  await monitor.scan();
  assert.equal(calls[0][0], 'transfer');
  assert.deepEqual(calls.at(-2), ['cursor', 112]);
  assert.deepEqual(calls.at(-1), ['confirm', 112]);
});
