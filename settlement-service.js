'use strict';
const { EthersArbitrumPayoutProvider } = require('./payout-provider.js');
const { PAYMENT_CONFIRMATIONS } = require('./payment-domain.js');
const { payoutAudit } = require('./payout-observability.js');
class SettlementService {
  constructor(repository, providerFactory = () => new EthersArbitrumPayoutProvider(), logger) { this.repository = repository; this.providerFactory = providerFactory; this.logger = logger; }
  async createSettlement(roundId) { return this.repository.createSettlement(roundId); }
  async executePayout(settlementId) { const provider = this.providerFactory(); const intent = await this.repository.executePayout(settlementId, provider); payoutAudit(this.logger, 'payout_execution_result', intent); return intent; }
  async confirmPayout(settlementId) { const provider = this.providerFactory(); const intent = await this.repository.payoutIntent(settlementId); const result = await this.repository.confirmPayout(settlementId, await provider.verifyTransfer(intent, PAYMENT_CONFIRMATIONS)); payoutAudit(this.logger, 'payout_confirmation_result', result.payoutIntent || intent); return result; }
  async reconcilePayout(settlementId) { const provider = this.providerFactory(); const result = await this.repository.reconcilePayout(settlementId, provider); payoutAudit(this.logger, 'payout_reconciliation_result', result); return result; }
  async dryRunPayout(settlementId, policy = {}) { const provider = this.providerFactory(); const intent = await this.repository.payoutIntent(settlementId); if (intent.status === 'confirmed') return { ...intent, dryRun: true, alreadyConfirmed: true }; const preflight = await provider.preflightTransfer({ recipient: intent.winnerWallet, amount: intent.winnerAmount, ...policy }); return { payoutIntentId: intent.id, settlementId, dryRun: true, signer: (await provider.identity()).address, chainId: preflight.chainId, tokenAddress: preflight.token, recipient: preflight.recipient, amount: preflight.amount, nonce: preflight.nonce, gasLimit: preflight.gasLimit, gasPrice: preflight.gasPrice, tokenBalance: preflight.tokenBalance, nativeBalance: preflight.nativeBalance };
  }
}
module.exports = { SettlementService };
