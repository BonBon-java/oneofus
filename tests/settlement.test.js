const test = require('node:test');
const assert = require('node:assert/strict');
const { settlementAmounts } = require('../settlement-domain.js');
const { SettlementService } = require('../settlement-service.js');
const { EthersTestnetPayoutProvider, AwsKmsStagingPayoutProvider } = require('../payout-provider.js');
const { payoutTargetConfig } = require('../payout-config.js');
const { ethers } = require('ethers');

test('calculates the fixed 15% organizer fee in exact USDT units', () => {
  assert.deepEqual(settlementAmounts('25650000'), { settlementBasis: '25650000', organizerFee: '3847500', winnerAmount: '21802500' });
  const exact = settlementAmounts('1000001');
  assert.equal(BigInt(exact.organizerFee) + BigInt(exact.winnerAmount), BigInt(exact.settlementBasis));
});

test('never uses floating point for large settlement values', () => {
  const basis = (2n ** 70n + 1234567n).toString(); const result = settlementAmounts(basis);
  assert.equal(BigInt(result.winnerAmount) + BigInt(result.organizerFee), BigInt(basis));
});

test('85/15 split preserves every USDT base unit for decimal edge cases', () => {
  for (const amount of ['1000000', '3001200', '10000001', '99999999']) {
    const split = settlementAmounts(amount);
    assert.equal(BigInt(split.winnerAmount) + BigInt(split.organizerFee), BigInt(amount));
    assert.equal(split.winnerAmount, (BigInt(amount) * 85n / 100n).toString());
  }
});

test('settlement service keeps payout execution behind an injected provider', async () => {
  const calls = []; const repository = {
    createSettlement: async () => ({ id: 'settlement', winnerWallet: '0xwinner', idempotent: true }),
    executePayout: async (_id, provider) => { calls.push(provider); return { status: 'broadcast' }; },
    payoutIntent: async () => ({ transactionHash: '0xtx' }),
    confirmPayout: async (_id, verification) => ({ status: verification.confirmed ? 'confirmed' : 'broadcast' }),
  };
  const provider = { verifyTransfer: async () => ({ confirmed: true, blockNumber: 1, networkFeeWei: '1' }) };
  const service = new SettlementService(repository, () => provider);
  assert.equal((await service.createSettlement('round')).id, 'settlement'); assert.equal((await service.executePayout('settlement')).status, 'broadcast'); assert.equal(calls.length, 1); assert.equal((await service.confirmPayout('settlement')).status, 'confirmed');
});

test('a provider failure before broadcast leaves no automatic second-send path', async () => {
  let sends = 0; const repository = { executePayout: async (_id, provider) => { try { await provider.recoverOrBroadcast({}); } catch { return { status: 'retryable' }; } } };
  const service = new SettlementService(repository, () => ({ recoverOrBroadcast: async () => { sends += 1; throw new Error('ambiguous'); } }));
  assert.equal((await service.executePayout('settlement')).status, 'retryable'); assert.equal(sends, 1);
});

test('payout signer fails closed when the server-only private key is missing', () => {
  const env = { ONE_OF_US_PAYOUT_MODE: 'testnet', ONE_OF_US_PAYOUT_RPC_URL: 'http://localhost:8545', ONE_OF_US_PAYOUT_CHAIN_ID: '31337', ONE_OF_US_PAYOUT_TOKEN_ADDRESS: '0x0000000000000000000000000000000000000001' };
  assert.throws(() => new EthersTestnetPayoutProvider({ env, privateKey: '' }), /ONE_OF_US_PAYOUT_PRIVATE_KEY/);
});

test('AWS KMS staging provider accepts no raw private key and rejects non-Sepolia targets', () => {
  const env = {
    ONE_OF_US_PAYOUT_MODE: 'testnet', ONE_OF_US_PAYOUT_RPC_URL: 'https://sepolia.example.test/rpc', ONE_OF_US_PAYOUT_CHAIN_ID: '421614', ONE_OF_US_PAYOUT_TOKEN_ADDRESS: '0x0000000000000000000000000000000000000001',
    ONE_OF_US_PAYOUT_SIGNER_MODE: 'aws-kms', AWS_REGION: 'eu-north-1', AWS_KMS_KEY_ID: 'alias/oneofus-kms-smoke-test', AWS_KMS_EXPECTED_KEY_ARN: 'arn:aws:kms:eu-north-1:123456789012:key/test-key', PAYOUT_EXPECTED_SIGNER_ADDRESS: '0x0000000000000000000000000000000000000002'
  };
  const kmsSigner = { identity: async () => ({ address: env.PAYOUT_EXPECTED_SIGNER_ADDRESS }), signTransaction: async () => ({ signedTransaction: '0x01' }) };
  const provider = new AwsKmsStagingPayoutProvider({ env, kmsSigner });
  assert.equal('privateKey' in provider.wallet, false, 'internal signer state must not expose a raw private key');
  assert.throws(() => new AwsKmsStagingPayoutProvider({ env: { ...env, ONE_OF_US_PAYOUT_CHAIN_ID: '31337' }, kmsSigner }), /Arbitrum Sepolia/);
});

test('payout target rejects disabled mode, mainnet, and production USDT before a provider exists', () => {
  const base = { ONE_OF_US_PAYOUT_MODE: 'testnet', ONE_OF_US_PAYOUT_RPC_URL: 'http://localhost:8545', ONE_OF_US_PAYOUT_CHAIN_ID: '31337', ONE_OF_US_PAYOUT_TOKEN_ADDRESS: '0x0000000000000000000000000000000000000001' };
  assert.deepEqual(payoutTargetConfig(base), { mode: 'testnet', rpcUrl: base.ONE_OF_US_PAYOUT_RPC_URL, chainId: 31337, tokenAddress: base.ONE_OF_US_PAYOUT_TOKEN_ADDRESS, decimals: 6, poolAddress: null, treasuryAddress: null, payoutMode: 'disabled' });
  assert.throws(() => payoutTargetConfig({ ...base, ONE_OF_US_PAYOUT_MODE: 'mainnet' }), /disabled/);
  assert.throws(() => payoutTargetConfig({ ...base, ONE_OF_US_PAYOUT_CHAIN_ID: '42161' }), /approved test/);
  assert.throws(() => payoutTargetConfig({ ...base, ONE_OF_US_PAYOUT_TOKEN_ADDRESS: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' }), /Production USDT/);
  assert.throws(() => payoutTargetConfig({ ...base, PAYOUT_MODE: 'test' }), /POOL_WALLET_ADDRESS/);
  assert.throws(() => payoutTargetConfig({ ...base, PAYOUT_MODE: 'production' }), /Only PAYOUT_MODE=test/);
});

test('payout token target requires exactly six integer decimal places', () => {
  const env = { ONE_OF_US_PAYOUT_MODE: 'testnet', ONE_OF_US_PAYOUT_RPC_URL: 'http://localhost:8545', ONE_OF_US_PAYOUT_CHAIN_ID: '31337', ONE_OF_US_PAYOUT_TOKEN_ADDRESS: '0x0000000000000000000000000000000000000001', ONE_OF_US_PAYOUT_TOKEN_DECIMALS: '18' };
  assert.throws(() => payoutTargetConfig(env), /6 decimals/);
});

test('confirmation requires the exact MockUSDT Transfer sender, recipient, and integer amount', async () => {
  const token = '0x0000000000000000000000000000000000000001'; const sender = '0x0000000000000000000000000000000000000002'; const winner = '0x0000000000000000000000000000000000000003';
  const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const event = iface.encodeEventLog(iface.getEvent('Transfer'), [sender, winner, 1000001n]);
  const fakeProvider = { getNetwork: async () => ({ chainId: 31337n }), getTransactionReceipt: async () => ({ status: 1, blockNumber: 5, gasUsed: 1n, gasPrice: 2n, logs: [{ address: token, topics: event.topics, data: event.data }] }), getTransaction: async () => ({ to: token }), getBlockNumber: async () => 5 };
  const payout = new EthersTestnetPayoutProvider({ target: { chainId: 31337, tokenAddress: token, decimals: 6 }, privateKey: `0x${'11'.repeat(32)}`, provider: fakeProvider });
  const intent = { chainId: 31337, tokenAddress: token, senderWallet: sender, winnerWallet: winner, winnerAmount: '1000001', transactionHash: `0x${'22'.repeat(32)}` };
  assert.equal((await payout.verifyTransfer(intent, 1)).confirmed, true);
  await assert.rejects(payout.verifyTransfer({ ...intent, winnerWallet: sender }, 1), /expected MockUSDT transfer/);
  await assert.rejects(payout.verifyTransfer({ ...intent, winnerAmount: '1000002' }, 1), /expected MockUSDT transfer/);
  await assert.rejects(payout.verifyTransfer({ ...intent, tokenAddress: '0x0000000000000000000000000000000000000004' }, 1), /token contract/);
});
