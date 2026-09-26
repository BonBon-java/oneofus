'use strict';
const { createPayoutProvider } = require('./payout-provider.js');
const { PAYMENT_CONFIRMATIONS } = require('./payment-domain.js');
const { payoutAudit } = require('./payout-observability.js');
class SettlementService {
  constructor(repository, providerFactory = () => createPayoutProvider(), logger) { this.repository = repository; this.providerFactory = providerFactory; this.logger = logger; }
  async createSettlement(roundId) { return this.repository.createSettlement(roundId); }
  async executePayout(settlementId) { const provider = this.providerFactory(); const settlement = this.repository.executeNextSettlementLeg ? await this.repository.executeNextSettlementLeg(settlementId, provider) : await this.repository.executePayout(settlementId, provider); payoutAudit(this.logger, 'payout_execution_result', settlement); return settlement; }
  async confirmPayout(settlementId) {
    const provider = this.providerFactory(); if (!this.repository.settlementLegs) { const intent = await this.repository.payoutIntent(settlementId); return this.repository.confirmPayout(settlementId, await provider.verifyTransfer(intent, PAYMENT_CONFIRMATIONS)); } const legs = await this.repository.settlementLegs(settlementId);
    const leg = legs.find((candidate) => ['broadcast', 'broadcast_unknown'].includes(candidate.status));
    if (!leg) return this.repository.confirmNextSettlementLeg(settlementId, { confirmed: false });
    const result = await this.repository.confirmNextSettlementLeg(settlementId, await provider.verifyTransfer(leg, PAYMENT_CONFIRMATIONS));
    payoutAudit(this.logger, 'payout_confirmation_result', result); return result;
  }
  async reconcilePayout(settlementId) { const provider = this.providerFactory(); const result = await this.repository.reconcilePayout(settlementId, provider); payoutAudit(this.logger, 'payout_reconciliation_result', result); return result; }
  async dryRunPayout(settlementId, policy = {}) { const provider = this.providerFactory(); const legs = await this.repository.settlementLegs(settlementId); const preflight = await provider.preflightTransfers(legs.map((leg) => ({ recipient: leg.recipientWallet, amount: leg.amount })), policy); return { settlementId, dryRun: true, signer: (await provider.identity()).address, chainId: preflight.chainId, tokenAddress: preflight.token, poolUsdtBalance: preflight.tokenBalance, poolEthBalanceWei: preflight.nativeBalance, estimatedTotalGasWei: preflight.estimatedGasWei, legs: preflight.transfers.map((transfer, index) => ({ kind: legs[index].kind, recipient: transfer.recipient, amount: transfer.amount, nonce: transfer.nonce, gasLimit: transfer.gasLimit, gasPrice: preflight.gasPrice })) };
  }
}
module.exports = { SettlementService };
