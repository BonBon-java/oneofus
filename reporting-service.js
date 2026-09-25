'use strict';
function gasStatus(balanceWei, averageGasWei, warningWei, criticalWei) { const balance = BigInt(balanceWei || 0); const average = BigInt(averageGasWei || 0); return { balanceWei: balance.toString(), severity: balance <= BigInt(criticalWei || 0) ? 'critical' : balance <= BigInt(warningWei || 0) ? 'warning' : 'ok', estimatedTransferCapacity: average > 0n ? (balance / average).toString() : null }; }
class ReportingService {
  constructor(repository, { gasBalanceWei = '0', averageGasWei = '0', warningGasWei = '0', criticalGasWei = '0' } = {}) { this.repository = repository; this.gas = { gasBalanceWei, averageGasWei, warningGasWei, criticalGasWei }; }
  async overview() { return { ...(await this.repository.reportingOverview()), gas: gasStatus(this.gas.gasBalanceWei, this.gas.averageGasWei, this.gas.warningGasWei, this.gas.criticalGasWei) }; }
  async settlements() { return this.repository.reportingSettlements(); }
}
module.exports = { ReportingService, gasStatus };
