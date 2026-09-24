const test = require('node:test');
const assert = require('node:assert/strict');
const { DRAND_NETWORK, drandCommitmentFor, winningTicketFromRandomness, resolveSnapshotRange } = require('../drand.js');
const { DrandWinnerService } = require('../drand-winner-service.js');

test('commits the first quicknet round strictly after snapshot finalization', () => {
  const at = new Date((DRAND_NETWORK.genesisTime + 3 * 100) * 1000 + 1427);
  const commitment = drandCommitmentFor(at);
  assert.equal(commitment.round, '102');
  assert.equal(commitment.scheduledAt.getTime(), (DRAND_NETWORK.genesisTime + 3 * 101) * 1000);
});

test('skips a drand round at the exact snapshot-finalization boundary', () => {
  const at = new Date((DRAND_NETWORK.genesisTime + 3 * 100) * 1000);
  assert.equal(drandCommitmentFor(at).round, '102');
});

test('maps exact entropy with BigInt and can select first or last ticket', () => {
  assert.equal(winningTicketFromRandomness('00'.repeat(32), 12).winningTicket, '1');
  const allOnes = 'ff'.repeat(32 - 1) + 'fb'; // divisible by 12 with remainder 11
  assert.equal(winningTicketFromRandomness(allOnes, 12).winningTicket, '12');
  const huge = (1n << 60n) + 7n;
  assert.ok(BigInt(winningTicketFromRandomness('01'.padStart(64, '0'), huge).winningTicket) >= 1n);
});

test('rejection sampling rehashes deterministically without modulo bias', () => {
  const first = winningTicketFromRandomness('ff'.repeat(32), 3);
  const second = winningTicketFromRandomness('ff'.repeat(32), 3);
  assert.equal(first.rejectionCounter, '1');
  assert.deepEqual(second, first);
});

test('resolves the winning owner only from one matching immutable snapshot range', () => {
  const ranges = [
    { id: 'a1', participantId: 'A', startTicket: '1', endTicket: '3' },
    { id: 'b', participantId: 'B', startTicket: '4', endTicket: '8' },
    { id: 'a2', participantId: 'A', startTicket: '9', endTicket: '12' },
  ];
  assert.equal(resolveSnapshotRange(ranges, '10').participantId, 'A');
  assert.throws(() => resolveSnapshotRange([{ startTicket: '1', endTicket: '5' }, { startTicket: '5', endTicket: '8' }], '5'), /exactly one/);
});

test('an unavailable or invalid drand beacon never records a winner and retry uses the same commitment', async () => {
  const calls = []; const repository = {
    getDrandCommitment: async () => ({ drandRound: '42', resultId: null }),
    recordVerifiedDrandResult: async (_round, beacon) => { calls.push(beacon); return { id: 'result' }; },
  };
  const unavailable = new DrandWinnerService(repository, { fetchRound: async () => { throw new Error('unavailable'); } });
  await assert.rejects(unavailable.resolveWinner('round'), /unavailable/);
  assert.equal(calls.length, 0);
  const invalid = new DrandWinnerService(repository, { fetchRound: async () => ({ round: 41, randomness: 'not-hex', signature: '' }) });
  await assert.rejects(invalid.resolveWinner('round'), /committed round/);
  assert.equal(calls.length, 0);
});
