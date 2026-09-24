'use strict';
const { VerifiedDrandClient } = require('./drand.js');

class DrandWinnerService {
  constructor(repository, drandClient = new VerifiedDrandClient()) { this.repository = repository; this.drandClient = drandClient; }
  async resolveWinner(roundId) {
    const commitment = await this.repository.getDrandCommitment(roundId);
    if (commitment.resultId) return this.repository.drawResult(roundId, true);
    // This is an exact historical round request. Failure deliberately leaves
    // the commitment untouched so a later retry cannot move the draw.
    const beacon = await this.drandClient.fetchRound(commitment.drandRound);
    if (String(beacon.round) !== String(commitment.drandRound)) throw new Error('drand beacon round differs from the committed round.');
    if (!/^[0-9a-f]{64}$/i.test(beacon.randomness || '') || !/^[0-9a-f]+$/i.test(beacon.signature || '')) throw new Error('drand beacon verification returned invalid material.');
    return this.repository.recordVerifiedDrandResult(roundId, beacon);
  }
}

module.exports = { DrandWinnerService };
