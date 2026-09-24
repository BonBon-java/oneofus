'use strict';
const crypto = require('node:crypto');
const { quicknetClient, fetchBeacon } = require('drand-client');

const DRAND_NETWORK = Object.freeze({
  id: 'quicknet',
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesisTime: 1692803367,
  periodSeconds: 3,
  schemeId: 'bls-unchained-g1-rfc9380',
});
const DRAND_ALGORITHM_VERSION = 'ONE_OF_US_DRAND_V1';
const REHASH_DOMAIN = Buffer.from('ONE_OF_US_DRAND_DRAW_V1\0', 'utf8');

function drandCommitmentFor(snapshotFinalizedAt) {
  const finalizedMs = BigInt(new Date(snapshotFinalizedAt).getTime());
  if (finalizedMs < BigInt(DRAND_NETWORK.genesisTime) * 1000n) throw new Error('Snapshot predates the configured drand network.');
  const periodMs = BigInt(DRAND_NETWORK.periodSeconds) * 1000n;
  // +2 deliberately skips a beacon at exactly the finalization timestamp.
  const round = (finalizedMs - BigInt(DRAND_NETWORK.genesisTime) * 1000n) / periodMs + 2n;
  const scheduledAt = new Date(Number((BigInt(DRAND_NETWORK.genesisTime) + (round - 1n) * BigInt(DRAND_NETWORK.periodSeconds)) * 1000n));
  return { ...DRAND_NETWORK, round: round.toString(), scheduledAt, algorithmVersion: DRAND_ALGORITHM_VERSION };
}

function winningTicketFromRandomness(randomness, totalEligibleTickets) {
  const total = BigInt(totalEligibleTickets);
  if (total < 1n) throw new Error('A draw needs at least one eligible ticket.');
  if (!/^[0-9a-f]{64}$/i.test(randomness)) throw new Error('drand randomness must be a 32-byte hexadecimal value.');
  const original = Buffer.from(randomness, 'hex'); let candidate = original; let counter = 0n;
  for (;;) {
    const limit = 1n << BigInt(candidate.length * 8); const value = BigInt(`0x${candidate.toString('hex')}`); const acceptedLimit = limit - (limit % total);
    if (value < acceptedLimit) return { winningTicket: (value % total + 1n).toString(), rejectionCounter: counter.toString() };
    counter += 1n;
    const counterBuffer = Buffer.alloc(8); counterBuffer.writeBigUInt64BE(counter);
    candidate = crypto.createHash('sha256').update(REHASH_DOMAIN).update(original).update(counterBuffer).digest();
  }
}

function resolveSnapshotRange(ranges, winningTicket) {
  const ticket = BigInt(winningTicket); const matching = ranges.filter((range) => BigInt(range.startTicket) <= ticket && ticket <= BigInt(range.endTicket));
  if (matching.length !== 1) throw new Error('Snapshot integrity failure: winning ticket does not map to exactly one range.');
  return matching[0];
}

class VerifiedDrandClient {
  async fetchRound(round) {
    // quicknetClient pins the official quicknet chain hash/public key and
    // fetchBeacon verifies both the returned round and its BLS signature.
    return fetchBeacon(quicknetClient(), Number(round));
  }
}

module.exports = { DRAND_NETWORK, DRAND_ALGORITHM_VERSION, drandCommitmentFor, winningTicketFromRandomness, resolveSnapshotRange, VerifiedDrandClient };
