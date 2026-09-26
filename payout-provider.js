'use strict';
const { ethers } = require('ethers');
const { payoutTargetConfig, stagingKmsSignerConfig } = require('./payout-config.js');
const { AwsKmsEthereumSigner, createAwsKmsClient } = require('./aws-kms-signer.js');
const TRANSFER_ABI = ['function transfer(address to, uint256 value) returns (bool)', 'function balanceOf(address owner) view returns (uint256)', 'function decimals() view returns (uint8)', 'event Transfer(address indexed from, address indexed to, uint256 value)'];
class PayoutPreflightError extends Error { constructor(code) { super(code); this.name = 'PayoutPreflightError'; this.code = code; } }

class EthersTestnetPayoutProvider {
  constructor({ env = process.env, rpcUrl, privateKey, target, provider, wallet } = {}) {
    this.target = target || payoutTargetConfig({ ...env, ...(rpcUrl ? { ONE_OF_US_PAYOUT_RPC_URL: rpcUrl } : {}) });
    const signerKey = privateKey === undefined ? env.ONE_OF_US_PAYOUT_PRIVATE_KEY : privateKey;
    if (!wallet && !signerKey) throw new Error('ONE_OF_US_PAYOUT_PRIVATE_KEY must be configured for testnet payout execution.');
    this.provider = provider || new ethers.JsonRpcProvider(this.target.rpcUrl); this.wallet = wallet || new ethers.Wallet(signerKey, this.provider); this.token = ethers.getAddress(this.target.tokenAddress);
  }
  async validateNetworkAndToken() {
    const network = await this.provider.getNetwork(); if (network.chainId !== BigInt(this.target.chainId)) throw new PayoutPreflightError('wrong_chain');
    const code = await this.provider.getCode(this.token); if (code === '0x') throw new PayoutPreflightError('missing_test_token_code');
    const token = new ethers.Contract(this.token, TRANSFER_ABI, this.provider); if (Number(await token.decimals()) !== this.target.decimals) throw new PayoutPreflightError('wrong_token_decimals');
    const sender = ethers.getAddress(await this.wallet.getAddress());
    if (this.target.poolAddress && sender !== ethers.getAddress(this.target.poolAddress)) throw new PayoutPreflightError('pool_signer_mismatch');
    return { sender, chainId: this.target.chainId, token: this.token };
  }
  async identity() { const config = await this.validateNetworkAndToken(); return { address: config.sender, mode: 'local-or-staging-raw-key' }; }
  async poolBalances() { const config = await this.validateNetworkAndToken(); const tokenBalance = await new ethers.Contract(this.token, TRANSFER_ABI, this.provider).balanceOf(config.sender); const nativeBalance = await this.provider.getBalance(config.sender); return { poolWallet: config.sender, usdtBaseUnits: tokenBalance.toString(), ethWei: nativeBalance.toString() }; }
  async preflightTransfer({ recipient, amount, maxAmount, minGasBalanceWei, maxGasPriceWei }) {
    const config = await this.validateNetworkAndToken(); const destination = ethers.getAddress(recipient); if (destination === ethers.ZeroAddress) throw new PayoutPreflightError('zero_recipient');
    const value = BigInt(amount); if (value <= 0n) throw new PayoutPreflightError('invalid_amount'); if (maxAmount !== undefined && value > BigInt(maxAmount)) throw new PayoutPreflightError('payout_limit_exceeded');
    const iface = new ethers.Interface(TRANSFER_ABI); const data = iface.encodeFunctionData('transfer', [destination, value]);
    const [nativeBalance, tokenBalance, nonceHex, feeData] = await Promise.all([this.provider.getBalance(config.sender), new ethers.Contract(this.token, TRANSFER_ABI, this.provider).balanceOf(config.sender), this.provider.send('eth_getTransactionCount', [config.sender, 'pending']), this.provider.getFeeData()]);
    const gasPrice = feeData.gasPrice; if (gasPrice === null) throw new PayoutPreflightError('missing_gas_price'); if (maxGasPriceWei !== undefined && gasPrice > BigInt(maxGasPriceWei)) throw new PayoutPreflightError('gas_price_limit_exceeded');
    if (tokenBalance < value) throw new PayoutPreflightError('insufficient_test_token'); const estimated = await this.provider.estimateGas({ from: config.sender, to: this.token, data }); const gasLimit = (estimated * 120n + 99n) / 100n;
    if (minGasBalanceWei !== undefined && nativeBalance < BigInt(minGasBalanceWei)) throw new PayoutPreflightError('native_gas_reserve_low');
    if (nativeBalance < gasLimit * gasPrice) throw new PayoutPreflightError('insufficient_native_gas');
    return { ...config, recipient: destination, amount: value.toString(), nonce: Number(nonceHex), gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), tokenBalance: tokenBalance.toString(), nativeBalance: nativeBalance.toString(), transaction: { chainId: this.target.chainId, nonce: Number(nonceHex), to: this.token, data, value: 0n, gasLimit, gasPrice } };
  }
  async preflightTransfers(transfers, { minGasBalanceWei, safetyMarginWei = 0n } = {}) {
    if (!Array.isArray(transfers) || transfers.length !== 2) throw new PayoutPreflightError('two_transfers_required');
    const config = await this.validateNetworkAndToken();
    const token = new ethers.Contract(this.token, TRANSFER_ABI, this.provider);
    const feeData = await this.provider.getFeeData(); const gasPrice = feeData.gasPrice;
    if (gasPrice === null) throw new PayoutPreflightError('missing_gas_price');
    const nonce = Number(await this.provider.send('eth_getTransactionCount', [config.sender, 'pending']));
    const normalized = transfers.map(({ recipient, amount }, index) => {
      const destination = ethers.getAddress(recipient); const value = BigInt(amount);
      if (destination === ethers.ZeroAddress || value <= 0n) throw new PayoutPreflightError('invalid_transfer');
      const data = new ethers.Interface(TRANSFER_ABI).encodeFunctionData('transfer', [destination, value]);
      return { recipient: destination, amount: value.toString(), data, nonce: nonce + index };
    });
    const [nativeBalance, tokenBalance, estimates] = await Promise.all([
      this.provider.getBalance(config.sender), token.balanceOf(config.sender),
      Promise.all(normalized.map((entry) => this.provider.estimateGas({ from: config.sender, to: this.token, data: entry.data })))
    ]);
    const requiredToken = normalized.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
    if (tokenBalance < requiredToken) throw new PayoutPreflightError('insufficient_test_token');
    const gasLimits = estimates.map((estimated) => (estimated * 120n + 99n) / 100n);
    const estimatedGasWei = gasLimits.reduce((sum, limit) => sum + limit * gasPrice, 0n);
    const requiredNative = estimatedGasWei + BigInt(safetyMarginWei);
    if (minGasBalanceWei !== undefined && nativeBalance < BigInt(minGasBalanceWei)) throw new PayoutPreflightError('native_gas_reserve_low');
    if (nativeBalance < requiredNative) throw new PayoutPreflightError('insufficient_native_gas');
    return { ...config, tokenBalance: tokenBalance.toString(), nativeBalance: nativeBalance.toString(), gasPrice: gasPrice.toString(), estimatedGasWei: estimatedGasWei.toString(), requiredToken: requiredToken.toString(), transfers: normalized.map((entry, index) => ({ ...entry, gasLimit: gasLimits[index].toString(), transaction: { chainId: this.target.chainId, nonce: entry.nonce, to: this.token, data: entry.data, value: 0n, gasLimit: gasLimits[index], gasPrice } })) };
  }
  async signTransfer({ recipient, amount }) {
    const config = await this.preflightTransfer({ recipient, amount });
    // JsonRpcProvider caches block-scoped reads. A payout signer must not reuse
    // that cached nonce after an immediately mined prior transfer, so query the
    // pending nonce directly from the node for every newly signed intent.
    const signedTransaction = await this.wallet.signTransaction(config.transaction); const hash = ethers.keccak256(signedTransaction);
    return { ...config, signedTransaction, transactionHash: hash };
  }
  async transactionByHash(transactionHash) {
    // Do not cache a just-missed transaction: recovery checks before broadcast
    // and confirmation follows immediately after it on local automining nodes.
    return typeof this.provider.send === 'function'
      ? this.provider.send('eth_getTransactionByHash', [transactionHash])
      : this.provider.getTransaction(transactionHash);
  }
  async recoverOrBroadcast(intent) {
    const known = await this.transactionByHash(intent.transactionHash); if (known) return { transactionHash: intent.transactionHash, state: 'submitted_pending', recovered: true };
    try { const sent = await this.provider.broadcastTransaction(intent.signedTransaction); return { transactionHash: sent.hash, state: 'submitted_pending', recovered: false }; }
    catch (error) {
      const afterError = await this.transactionByHash(intent.transactionHash); if (afterError) return { transactionHash: intent.transactionHash, state: 'submitted_pending', recovered: true };
      throw error;
    }
  }
  async reconcileUnknown(intent) {
    const transaction = await this.transactionByHash(intent.transactionHash);
    if (transaction) return { state: 'submitted_pending', transactionHash: intent.transactionHash, evidence: 'transaction_hash' };
    const currentNonce = Number(await this.provider.send('eth_getTransactionCount', [intent.senderWallet || intent.sender_wallet, 'pending']));
    if (intent.nonce !== null && intent.nonce !== undefined && currentNonce > Number(intent.nonce)) return { state: 'manual_review', evidence: 'nonce_consumed_without_hash' };
    return { state: 'broadcast_unknown', evidence: 'no_provider_evidence' };
  }
  async verifyTransfer(intent, confirmations) {
    const network = await this.provider.getNetwork(); if (network.chainId !== BigInt(intent.chainId)) throw new Error('Payout verification is connected to the wrong network.');
    const receipt = await this.provider.getTransactionReceipt(intent.transactionHash); if (!receipt) return { confirmed: false, state: 'not_confirmed' };
    if (receipt.status !== 1) throw new Error('Payout transaction reverted on-chain.');
    const tokenAddress = intent.tokenAddress || intent.token_address; const recipient = intent.recipientWallet || intent.recipient_wallet || intent.winnerWallet || intent.winner_wallet; const amount = intent.amount || intent.winnerAmount || intent.winner_amount; const sender = intent.senderWallet || intent.sender_wallet;
    const transaction = await this.transactionByHash(intent.transactionHash); if (!transaction || ethers.getAddress(transaction.to) !== ethers.getAddress(tokenAddress)) throw new Error('Payout transaction token contract does not match its intent.');
    const iface = new ethers.Interface(TRANSFER_ABI); const expectedRecipient = ethers.getAddress(recipient); const expectedAmount = BigInt(amount); const matched = receipt.logs.some((log) => {
      if (ethers.getAddress(log.address) !== ethers.getAddress(tokenAddress)) return false;
      try { const parsed = iface.parseLog(log); return parsed?.name === 'Transfer' && (!sender || ethers.getAddress(parsed.args.from) === ethers.getAddress(sender)) && ethers.getAddress(parsed.args.to) === expectedRecipient && BigInt(parsed.args.value) === expectedAmount; } catch { return false; }
    });
    if (!matched) throw new Error('Payout transaction does not contain the expected MockUSDT transfer.');
    const head = typeof this.provider.send === 'function' ? Number(await this.provider.send('eth_blockNumber', [])) : await this.provider.getBlockNumber(); if (head - receipt.blockNumber + 1 < confirmations) return { confirmed: false, state: 'submitted_pending' };
    const effectiveGasPrice = receipt.gasPrice ?? receipt.effectiveGasPrice;
    return { confirmed: true, state: 'confirmed', blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: effectiveGasPrice.toString(), networkFeeWei: (receipt.gasUsed * effectiveGasPrice).toString() };
  }
}

class AwsKmsStagingPayoutProvider extends EthersTestnetPayoutProvider {
  constructor({ env = process.env, kms, kmsSigner, ...options } = {}) {
    const kmsConfig = stagingKmsSignerConfig(env);
    const target = options.target || payoutTargetConfig({ ...env, ...(options.rpcUrl ? { ONE_OF_US_PAYOUT_RPC_URL: options.rpcUrl } : {}) });
    if (target.chainId !== 421614) throw new Error('AWS KMS payout signing is limited to Arbitrum Sepolia staging.');
    const signer = kmsSigner || new AwsKmsEthereumSigner({ kms: kms || createAwsKmsClient({ region: kmsConfig.region }), keyId: kmsConfig.keyId, expectedAddress: kmsConfig.expectedAddress, region: kmsConfig.region, expectedKeyArn: kmsConfig.expectedKeyArn });
    const wallet = {
      getAddress: async () => (await signer.identity()).address,
      signTransaction: async (transaction) => (await signer.signTransaction(transaction)).signedTransaction
    };
    super({ env, ...options, target, wallet });
    this.kmsSigner = signer;
  }
  async identity() { const config = await this.validateNetworkAndToken(); return { address: config.sender, mode: 'staging-aws-kms' }; }
}

function createPayoutProvider(options = {}) {
  return options.env?.ONE_OF_US_PAYOUT_SIGNER_MODE === 'aws-kms' || (!options.env && process.env.ONE_OF_US_PAYOUT_SIGNER_MODE === 'aws-kms')
    ? new AwsKmsStagingPayoutProvider(options)
    : new EthersTestnetPayoutProvider(options);
}

module.exports = { EthersTestnetPayoutProvider, EthersArbitrumPayoutProvider: EthersTestnetPayoutProvider, AwsKmsStagingPayoutProvider, createPayoutProvider, PayoutPreflightError, TRANSFER_ABI };
