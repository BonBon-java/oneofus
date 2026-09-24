'use strict';
const { USDT_DECIMALS, PAYMENT_CONFIRMATIONS, PAYMENT_SCAN_LOOKBACK_BLOCKS } = require('./payment-domain.js');
const { paymentNetwork } = require('./payment-network.js');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = (number) => `0x${Number(number).toString(16)}`;
const parseHex = (value) => Number.parseInt(value, 16);
const addressTopic = (address) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
class ArbitrumPaymentMonitor {
  constructor({ repository, service, rpcUrl, receivingAddress, fetchFunction = fetch, pollInterval = Number(process.env.PAYMENT_POLL_INTERVAL_MS || 15000), target = paymentNetwork(), confirmations = PAYMENT_CONFIRMATIONS }) { Object.assign(this, { repository, service, rpcUrl, receivingAddress, fetchFunction, pollInterval, target, confirmations }); }
  async rpc(method, params) { const response = await this.fetchFunction(this.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const body = await response.json(); if (!response.ok || body.error) throw new Error(body.error?.message || 'Arbitrum RPC request failed.'); return body.result; }
  async scan() {
    await this.service.expirePending(); const head = parseHex(await this.rpc('eth_blockNumber', []));
    // Rescan a small confirmed history on every run. Database event uniqueness
    // makes this safe and covers restarts plus shallow chain reorganizations.
    const cursor = await this.repository.getScannerBlock(this.target.scannerName); const from = cursor === null ? Math.max(0, head - PAYMENT_SCAN_LOOKBACK_BLOCKS) : Math.max(0, Number(cursor) - PAYMENT_SCAN_LOOKBACK_BLOCKS + 1);
    if (from <= head) {
      const logs = await this.rpc('eth_getLogs', [{ address: this.target.tokenAddress, fromBlock: hex(from), toBlock: hex(head), topics: [TRANSFER_TOPIC, null, addressTopic(this.receivingAddress)] }]);
      for (const log of logs) await this.recordLog(log);
      await this.repository.setScannerBlock(this.target.scannerName, head);
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
  async confirm(head) { return this.repository.confirmPayments(head, this.confirmations); }
  start() {
    Promise.all([this.verifyNetwork(), this.verifyTokenDecimals()])
      .then(() => {
        this.scan().catch(console.error);
        this.timer = setInterval(() => this.scan().catch(console.error), this.pollInterval);
      })
      .catch((error) => console.error('Arbitrum payment monitor did not start:', error));
  }
}
module.exports = { ArbitrumPaymentMonitor, TRANSFER_TOPIC };
