'use strict';
const { ethers } = require('ethers');
const { payoutTargetConfig } = require('./payout-config.js');
const TRANSFER_ABI = ['function transfer(address to, uint256 value) returns (bool)', 'function balanceOf(address owner) view returns (uint256)', 'function decimals() view returns (uint8)', 'event Transfer(address indexed from, address indexed to, uint256 value)'];
class PayoutPreflightError extends Error { constructor(code) { super(code); this.name = 'PayoutPreflightError'; this.code = code; } }

class EthersTestnetPayoutProvider {
  constructor({ env = process.env, rpcUrl, privateKey, target, provider, wallet } = {}) {
    this.target = target || payoutTargetConfig({ ...env, ...(rpcUrl ? { ONE_OF_US_PAYOUT_RPC_URL: rpcUrl } : {}) });
    const signerKey = privateKey === undefined ? env.ONE_OF_US_PAYOUT_PRIVATE_KEY : privateKey;
    if (!signerKey) throw new Error('ONE_OF_US_PAYOUT_PRIVATE_KEY must be configured for testnet payout execution.');
    this.provider = provider || new ethers.JsonRpcProvider(this.target.rpcUrl); this.wallet = wallet || new ethers.Wallet(signerKey, this.provider); this.token = ethers.getAddress(this.target.tokenAddress);
  }
  async validateNetworkAndToken() {
    const network = await this.provider.getNetwork(); if (network.chainId !== BigInt(this.target.chainId)) throw new PayoutPreflightError('wrong_chain');
    const code = await this.provider.getCode(this.token); if (code === '0x') throw new PayoutPreflightError('missing_test_token_code');
    const token = new ethers.Contract(this.token, TRANSFER_ABI, this.provider); if (Number(await token.decimals()) !== this.target.decimals) throw new PayoutPreflightError('wrong_token_decimals');
    return { sender: await this.wallet.getAddress(), chainId: this.target.chainId, token: this.token };
  }
  async signTransfer({ recipient, amount }) {
    const config = await this.validateNetworkAndToken(); const destination = ethers.getAddress(recipient); const value = BigInt(amount); if (value <= 0n) throw new Error('Payout amount must be positive.');
    const iface = new ethers.Interface(TRANSFER_ABI); const data = iface.encodeFunctionData('transfer', [destination, value]);
    // JsonRpcProvider caches block-scoped reads. A payout signer must not reuse
    // that cached nonce after an immediately mined prior transfer, so query the
    // pending nonce directly from the node for every newly signed intent.
    const [nativeBalance, tokenBalance, nonceHex, feeData] = await Promise.all([this.provider.getBalance(config.sender), new ethers.Contract(this.token, TRANSFER_ABI, this.provider).balanceOf(config.sender), this.provider.send('eth_getTransactionCount', [config.sender, 'pending']), this.provider.getFeeData()]);
    const nonce = Number(nonceHex);
    const gasPrice = feeData.gasPrice; if (gasPrice === null) throw new PayoutPreflightError('missing_gas_price');
    if (tokenBalance < value) throw new PayoutPreflightError('insufficient_test_token');
    const gasLimit = await this.provider.estimateGas({ from: config.sender, to: this.token, data });
    if (nativeBalance < gasLimit * gasPrice) throw new PayoutPreflightError('insufficient_native_gas');
    const transaction = { chainId: this.target.chainId, nonce, to: this.token, data, value: 0n, gasLimit, gasPrice };
    const signedTransaction = await this.wallet.signTransaction(transaction); const hash = ethers.keccak256(signedTransaction);
    return { ...config, recipient: destination, amount: value.toString(), nonce, gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), signedTransaction, transactionHash: hash };
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
  async verifyTransfer(intent, confirmations) {
    const network = await this.provider.getNetwork(); if (network.chainId !== BigInt(intent.chainId)) throw new Error('Payout verification is connected to the wrong network.');
    const receipt = await this.provider.getTransactionReceipt(intent.transactionHash); if (!receipt) return { confirmed: false, state: 'not_confirmed' };
    if (receipt.status !== 1) throw new Error('Payout transaction reverted on-chain.');
    const tokenAddress = intent.tokenAddress || intent.token_address; const recipient = intent.winnerWallet || intent.winner_wallet; const amount = intent.winnerAmount || intent.winner_amount; const sender = intent.senderWallet || intent.sender_wallet;
    const transaction = await this.transactionByHash(intent.transactionHash); if (!transaction || ethers.getAddress(transaction.to) !== ethers.getAddress(tokenAddress)) throw new Error('Payout transaction token contract does not match its intent.');
    const iface = new ethers.Interface(TRANSFER_ABI); const expectedRecipient = ethers.getAddress(recipient); const expectedAmount = BigInt(amount); const matched = receipt.logs.some((log) => {
      if (ethers.getAddress(log.address) !== ethers.getAddress(tokenAddress)) return false;
      try { const parsed = iface.parseLog(log); return parsed?.name === 'Transfer' && (!sender || ethers.getAddress(parsed.args.from) === ethers.getAddress(sender)) && ethers.getAddress(parsed.args.to) === expectedRecipient && BigInt(parsed.args.value) === expectedAmount; } catch { return false; }
    });
    if (!matched) throw new Error('Payout transaction does not contain the expected MockUSDT transfer.');
    const head = typeof this.provider.send === 'function' ? Number(await this.provider.send('eth_blockNumber', [])) : await this.provider.getBlockNumber(); if (head - receipt.blockNumber + 1 < confirmations) return { confirmed: false, state: 'submitted_pending' };
    return { confirmed: true, state: 'confirmed', blockNumber: receipt.blockNumber, networkFeeWei: (receipt.gasUsed * receipt.gasPrice).toString() };
  }
}
module.exports = { EthersTestnetPayoutProvider, EthersArbitrumPayoutProvider: EthersTestnetPayoutProvider, PayoutPreflightError, TRANSFER_ABI };
