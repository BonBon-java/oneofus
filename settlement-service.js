'use strict';
const { EthersArbitrumPayoutProvider } = require('./payout-provider.js');
const { PAYMENT_CONFIRMATIONS } = require('./payment-domain.js');
const { payoutAudit } = require('./payout-observability.js');
class SettlementService {
  constructor(repository, providerFactory = () => new EthersArbitrumPayoutProvider(), logger) { this.repository = repository; this.providerFactory = providerFactory; this.logger = logger; }
  async createSettlement(roundId) { return this.repository.createSettlement(roundId); }
  async executePayout(settlementId) { const provider = this.providerFactory(); const intent = await this.repository.executePayout(settlementId, provider); payoutAudit(this.logger, 'payout_execution_result', intent); return intent; }
  async confirmPayout(settlementId) { const provider = this.providerFactory(); const intent = await this.repository.payoutIntent(settlementId); const result = await this.repository.confirmPayout(settlementId, await provider.verifyTransfer(intent, PAYMENT_CONFIRMATIONS)); payoutAudit(this.logger, 'payout_confirmation_result', result.payoutIntent || intent); return result; }
}
module.exports = { SettlementService };
