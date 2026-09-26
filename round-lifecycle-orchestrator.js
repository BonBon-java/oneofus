'use strict';
const crypto = require('node:crypto');
const { RoundClosingService } = require('./round-service.js');
const { DrawSnapshotService } = require('./draw-snapshot-service.js');
const { DrandWinnerService } = require('./drand-winner-service.js');
const { SettlementService } = require('./settlement-service.js');

const TERMINAL = new Set(['completed', 'rolled_over']);
function retryable(error) { return /drand|network|rpc|timeout|temporar|not_confirmed|fetch/i.test(error?.message || ''); }

class RoundLifecycleOrchestrator {
  constructor({ repository, roundService, snapshotService, drandService, settlementService, logger = console, workerId = crypto.randomUUID(), retrySeconds = 30, leaseSeconds = 30 } = {}) {
    if (!repository) throw new Error('RoundLifecycleOrchestrator requires a repository.');
    Object.assign(this, { repository, roundService: roundService || new RoundClosingService(repository), snapshotService: snapshotService || new DrawSnapshotService(repository), drandService: drandService || new DrandWinnerService(repository), settlementService: settlementService || new SettlementService(repository), logger, workerId, retrySeconds, leaseSeconds });
  }
  log(event, fields = {}) { this.logger?.info?.({ event, workerId: this.workerId, ...fields }); }
  async processRound(roundId) {
    if (!await this.repository.claimRound(roundId, this.workerId, this.leaseSeconds)) return { roundId, action: 'CLAIM_SKIPPED' };
    let action = 'NOOP';
    try {
      // Re-read persisted state after acquiring the lease; never keep workflow
      // truth in memory and never infer missing financial domain data here.
      let round = await this.repository.roundById(roundId); if (!round) return { roundId, action: 'MISSING' };
      for (let steps = 0; steps < 8 && !TERMINAL.has(round.status); steps += 1) {
        const previousState = round.status;
        if (round.status === 'open') { if (new Date(round.closes_at) > new Date()) break; const closed = await this.roundService.closeRound(roundId); action = closed.status === 'rolled_over' ? 'ROUND_ROLLED_OVER' : 'ROUND_CLOSE_STARTED'; }
        else if (round.status === 'locked') { await this.snapshotService.createDrawSnapshot(roundId); action = 'SNAPSHOT_CREATED'; }
        else if (round.status === 'waiting_for_randomness') { await this.drandService.resolveWinner(roundId); action = 'WINNER_SELECTED'; }
        else if (round.status === 'winner_selected') { await this.settlementService.createSettlement(roundId); action = 'SETTLEMENT_CREATED'; }
        else if (round.status === 'settlement_pending' || round.status === 'payout_retryable') { const settlementId = await this.repository.settlementForRound(roundId); if (!settlementId) { await this.settlementService.createSettlement(roundId); action = 'SETTLEMENT_CREATED'; } else { const intent = await this.settlementService.executePayout(settlementId); action = ['broadcast', 'winner_submitted', 'treasury_submitted'].includes(intent.status) ? 'PAYOUT_BROADCAST' : 'PAYOUT_RETRY'; } }
        else if (round.status === 'payout_broadcast') {
          const settlementId = await this.repository.settlementForRound(roundId); if (!this.repository.getSettlement) { const confirmed = await this.settlementService.confirmPayout(settlementId); action = confirmed.status === 'confirmed' ? 'ROUND_COMPLETED' : 'PAYOUT_CONFIRMING'; round = await this.repository.roundById(roundId); continue; } const settlement = await this.repository.getSettlement(settlementId);
          if (['winner_submitted', 'treasury_submitted'].includes(settlement.status)) { const confirmed = await this.settlementService.confirmPayout(settlementId); action = confirmed.status === 'settled' ? 'ROUND_COMPLETED' : 'PAYOUT_CONFIRMING'; }
          else if (settlement.status === 'settled') action = 'ROUND_COMPLETED';
          else { const advanced = await this.settlementService.executePayout(settlementId); action = advanced.status === 'treasury_submitted' ? 'TREASURY_BROADCAST' : 'PAYOUT_RETRY'; }
        }
        else break;
        round = await this.repository.roundById(roundId); this.log(action, { roundId, previousState, resultingState: round.status });
        if (action === 'PAYOUT_RETRY') break;
      }
      await this.repository.recordLifecycleSuccess(roundId, this.workerId, action); return { roundId, action, status: round.status };
    } catch (error) {
      if (retryable(error)) { await this.repository.recordLifecycleRetry(roundId, this.workerId, action, 'transient', error.message, this.retrySeconds); this.log('ROUND_PROCESS_RETRY', { roundId, action, error: error.message }); return { roundId, action: 'RETRY' }; }
      await this.repository.recordLifecycleFailure(roundId, this.workerId, action, 'integrity_or_operational', error.message); this.log('ROUND_PROCESS_ERROR', { roundId, action, error: error.message }); throw error;
    }
  }
  async sweep(limit = 50) { const ids = await this.repository.runnableRoundIds(limit); return Promise.all(ids.map((id) => this.processRound(id))); }
}
class RoundLifecycleScheduler {
  constructor(orchestrator, { intervalMs = Number(process.env.ONE_OF_US_SCHEDULER_INTERVAL_MS || 15000), logger = console } = {}) { this.orchestrator = orchestrator; this.intervalMs = intervalMs; this.logger = logger; }
  async tick() { try { return await this.orchestrator.sweep(); } catch (error) { this.logger?.error?.({ event: 'ROUND_SCHEDULER_ERROR', error: error.message }); return []; } }
  start() { if (this.timer) return; this.tick(); this.timer = setInterval(() => this.tick(), this.intervalMs); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
module.exports = { RoundLifecycleOrchestrator, RoundLifecycleScheduler, TERMINAL };
