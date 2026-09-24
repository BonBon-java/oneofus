'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoundLifecycleOrchestrator } = require('../round-lifecycle-orchestrator.js');

function harness(initial) {
  let status = initial; const calls = []; let claimed = false;
  const repository = { claimRound: async () => { if (claimed) return false; claimed = true; return true; }, roundById: async () => ({ id: 'round', status, closes_at: new Date(0) }), settlementForRound: async () => 'settlement', recordLifecycleSuccess: async (_id, _worker, action) => calls.push(`success:${action}`), recordLifecycleRetry: async () => calls.push('retry'), recordLifecycleFailure: async () => calls.push('failure') };
  const services = {
    roundService: { closeRound: async () => { calls.push('close'); status = 'locked'; return { status: 'locked' }; } },
    snapshotService: { createDrawSnapshot: async () => { calls.push('snapshot'); status = 'waiting_for_randomness'; } },
    drandService: { resolveWinner: async () => { calls.push('drand'); status = 'winner_selected'; } },
    settlementService: { createSettlement: async () => { calls.push('settlement'); status = 'settlement_pending'; }, executePayout: async () => { calls.push('payout'); status = 'payout_broadcast'; return { status: 'broadcast' }; }, confirmPayout: async () => { calls.push('confirm'); status = 'completed'; return { status: 'confirmed' }; } },
  };
  return { repository, services, calls, status: () => status };
}
test('orchestrator coordinates persisted lifecycle services through completion', async () => {
  const h = harness('open'); const result = await new RoundLifecycleOrchestrator({ repository: h.repository, ...h.services, logger: null }).processRound('round');
  assert.equal(result.status, 'completed'); assert.deepEqual(h.calls.slice(0, 6), ['close','snapshot','drand','settlement','payout','confirm']);
});
test('orchestrator stops after an underfilled rollover without draw work', async () => {
  const h = harness('open'); h.services.roundService.closeRound = async () => { h.calls.push('close'); return { status: 'rolled_over' }; }; h.repository.roundById = async () => ({ id: 'round', status: h.calls.includes('close') ? 'rolled_over' : 'open', closes_at: new Date(0) });
  const result = await new RoundLifecycleOrchestrator({ repository: h.repository, ...h.services, logger: null }).processRound('round'); assert.equal(result.status, 'rolled_over'); assert.deepEqual(h.calls.slice(0, 1), ['close']);
});
test('drand outage is persisted as a retry instead of advancing the draw', async () => {
  const h = harness('waiting_for_randomness'); h.services.drandService.resolveWinner = async () => { throw new Error('drand network timeout'); };
  const result = await new RoundLifecycleOrchestrator({ repository: h.repository, ...h.services, logger: null }).processRound('round'); assert.equal(result.action, 'RETRY'); assert.ok(h.calls.includes('retry'));
});
