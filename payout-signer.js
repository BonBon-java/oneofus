'use strict';

const { ethers } = require('ethers');

// This boundary deliberately has no generic signTransaction/sendTransaction API.
// Application code can ask only for an already persisted ERC-20 payout intent.
class PayoutSigner {
  async identity() { throw new Error('PayoutSigner.identity must be implemented.'); }
  async prepareApprovedTransfer() { throw new Error('PayoutSigner.prepareApprovedTransfer must be implemented.'); }
  async broadcastApprovedTransfer() { throw new Error('PayoutSigner.broadcastApprovedTransfer must be implemented.'); }
}

class ExternalPayoutSigner extends PayoutSigner {
  constructor({ expectedAddress, client, mode = 'production-external' }) {
    super();
    if (!expectedAddress) throw new Error('Expected payout signer address is required.');
    if (!client || typeof client.identity !== 'function' || typeof client.prepareErc20Transfer !== 'function' || typeof client.broadcastPreparedTransfer !== 'function') throw new Error('External payout signer client is incomplete.');
    this.expectedAddress = ethers.getAddress(expectedAddress);
    this.client = client;
    this.mode = mode;
  }
  async identity() {
    const address = ethers.getAddress((await this.client.identity()).address);
    if (address !== this.expectedAddress) throw new Error('External payout signer address does not match PAYOUT_EXPECTED_SIGNER_ADDRESS.');
    return { address, mode: this.mode };
  }
  async prepareApprovedTransfer(intent) {
    await this.identity();
    return this.client.prepareErc20Transfer({ payoutIntentId: intent.id, chainId: intent.chainId, tokenAddress: intent.tokenAddress, recipient: intent.winnerWallet, amount: intent.winnerAmount });
  }
  async broadcastApprovedTransfer(prepared) { return this.client.broadcastPreparedTransfer(prepared); }
}

// Adapter contract for a KMS/MPC-backed signer service. The service is expected
// to enforce its own token/chain allow-list and emit an audit record keyed by
// payoutIntentId. No private key is ever loaded by this process.
class HttpIsolatedSignerClient {
  constructor({ url, token, fetchImpl = globalThis.fetch }) {
    if (!url || !/^https:\/\//.test(url)) throw new Error('PAYOUT_SIGNER_URL must be an HTTPS URL.');
    if (!token) throw new Error('PAYOUT_SIGNER_AUTH_TOKEN is required for the isolated signer.');
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required for the isolated signer.');
    this.url = url.replace(/\/$/, ''); this.token = token; this.fetch = fetchImpl;
  }
  async request(path, body) {
    const response = await this.fetch(`${this.url}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Isolated signer request failed (${response.status}).`);
    return response.json();
  }
  async identity() { return this.request('/v1/payout-signer/identity'); }
  async prepareErc20Transfer(intent) { return this.request('/v1/payout-signer/prepare-erc20-transfer', intent); }
  async broadcastPreparedTransfer(prepared) { return this.request('/v1/payout-signer/broadcast-prepared-transfer', prepared); }
}

module.exports = { PayoutSigner, ExternalPayoutSigner, HttpIsolatedSignerClient };
