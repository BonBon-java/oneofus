'use strict';
const { USDT_DECIMALS, PAYMENT_CONFIRMATIONS, PAYMENT_SCAN_LOOKBACK_BLOCKS } = require('./payment-domain.js');
const { paymentNetwork } = require('./payment-network.js');
const { ResilientRpcClient } = require('./rpc-client.js');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = (number) => `0x${Number(number).toString(16)}`;
const parseHex = (value) => Number.parseInt(value, 16);
const addressTopic = (address) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
class ArbitrumPaymentMonitor {
  constructor({ repository, service, rpcUrl, rpcUrls, rpcClient, receivingAddress, fetchFunction = fetch, pollInterval = Number(process.env.PAYMENT_POLL_INTERVAL_MS || 15000), target = paymentNetwork(), confirmations = PAYMENT_CONFIRMATIONS, scanMaxBlocks = Number(process.env.ONE_OF_US_SCAN_MAX_BLOCKS || 500) }) { Object.assign(this, { repository, service, rpcUrl, receivingAddress, fetchFunction, pollInterval, target, confirmations, scanMaxBlocks, rpcClient: rpcClient || new ResilientRpcClient({ urls: rpcUrls || [rpcUrl], fetchFunction, timeoutMs: Number(process.env.ONE_OF_US_RPC_TIMEOUT_MS || 10000), attempts: Number(process.env.ONE_OF_US_RPC_ATTEMPTS || 3) }) }); }
  async rpc(method, params) { return this.rpcClient.call(method, params); }
  async scan() {
    await this.service.expirePending(); const head = parseHex(await this.rpc('eth_blockNumber', []));
    // Rescan a small confirmed history on every run. Database event uniqueness
    // makes this safe and covers restarts plus shallow chain reorganizations.
    const cursor = await this.repository.getScannerBlock(this.target.scannerName); const from = cursor === null ? Math.max(0, head - PAYMENT_SCAN_LOOKBACK_BLOCKS) : Math.max(0, Number(cursor) - PAYMENT_SCAN_LOOKBACK_BLOCKS + 1);
    if (from <= head) for (let chunkFrom = from; chunkFrom <= head; chunkFrom += this.scanMaxBlocks) {
      const chunkTo = Math.min(head, chunkFrom + this.scanMaxBlocks - 1);
      const logs = await this.rpc('eth_getLogs', [{ address: this.target.tokenAddress, fromBlock: hex(chunkFrom), toBlock: hex(chunkTo), topics: [TRANSFER_TOPIC, null, addressTopic(this.receivingAddress)] }]);
      for (const log of logs) await this.recordLog(log);
      await this.repository.setScannerBlock(this.target.scannerName, chunkTo);
    }
    await this.confirm(head);
  }
  async verifyTokenDecimals() {
    const result = await this.rpc('eth_call', [{ to: this.target.tokenAddress, data: '0x313ce567' }, 'latest']);
    if (parseHex(result) !== USDT_DECIMALS) throw new Error(`Configured USDT decimals (${USDT_DECIMALS}) do not match the contract response.`);
  }
  async verifyNetwork() {
    const chainId = parseHex(await this.rpc('eth_chainId', []));
    if (chainId !== this.target.chainId) throw new Error(`RPC chain ID (${chainId}) does not match ${this.target.network} (${this.target.chainId}).`);
  }
  async recordLog(log) { return this.repository.recordTransfer(log, { tokenAddress: this.target.tokenAddress, receivingAddress: this.receivingAddress }); }
  async confirm(head) {
    const blocks = await this.repository.pendingPaymentBlocks(head, this.confirmations);
    const canonical = new Map();
    for (const blockNumber of blocks) { const block = await this.rpc('eth_getBlockByNumber', [hex(blockNumber), false]); if (!block?.hash) throw new Error('RPC returned an invalid canonical block.'); canonical.set(blockNumber, block.hash.toLowerCase()); }
    return this.repository.confirmPayments(head, this.confirmations, canonical);
  }
  start() {
    Promise.all([this.verifyNetwork(), this.verifyTokenDecimals()])
      .then(() => {
        this.scan().catch(console.error);
        this.timer = setInterval(() => this.scan().catch(console.error), this.pollInterval);
      })
      .catch((error) => console.error('Arbitrum payment monitor did not start:', error));
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  status() { return { ...this.rpcClient.status(), scannerName: this.target.scannerName }; }
}
module.exports = { ArbitrumPaymentMonitor, TRANSFER_TOPIC };
