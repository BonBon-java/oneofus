const test = require('node:test');
const assert = require('node:assert/strict');
const { roundClosePlan } = require('../postgres-repository.js');
const { RoundClosingService } = require('../round-service.js');

test('nine paid tickets roll over regardless of free-ticket count', () => {
  assert.deepEqual(roundClosePlan(9, 0, '7650000'), { status: 'rolled_over', paidTicketCount: 9, freeTicketCount: 0, winnerPoolAmount: '7650000', carriedAmount: '7650000' });
  assert.deepEqual(roundClosePlan(9, 100, '7650000'), { status: 'rolled_over', paidTicketCount: 9, freeTicketCount: 100, winnerPoolAmount: '7650000', carriedAmount: '7650000' });
});

test('exactly ten and more paid tickets become draw-ready without rollover', () => {
  for (const paidTickets of [10, 17]) assert.deepEqual(roundClosePlan(paidTickets, 100, '10000000'), { status: 'locked', paidTicketCount: paidTickets, freeTicketCount: 100, winnerPoolAmount: '10000000', carriedAmount: '0' });
});

test('round closing service preserves repository idempotency result', async () => {
  const result = { roundId: 'round', status: 'rolled_over', nextRoundId: 'next', idempotent: true };
  const service = new RoundClosingService({ closeRound: async (id) => ({ ...result, roundId: id }) });
  assert.deepEqual(await service.closeRound('round'), result);
});
