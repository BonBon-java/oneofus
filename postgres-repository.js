'use strict';
const crypto = require('node:crypto');
const { amountFor, paymentAmountsFor, paymentIdentifierFor, PAYMENT_CODE_COOLDOWN_MINUTES, PAYMENT_RESERVATION_MINUTES } = require('./payment-domain.js');
const { drandCommitmentFor, winningTicketFromRandomness, resolveSnapshotRange } = require('./drand.js');
const { settlementAmounts } = require('./settlement-domain.js');
const { payoutTargetConfig } = require('./payout-config.js');
const MIN_PAID_TICKETS_FOR_DRAW = 10;
const tokenUnits = 1_000_000n;
// Include carried tickets without changing their immutable origin round.
const activeEligibilitySql = `WITH RECURSIVE eligible_rounds AS (
  SELECT id, previous_round_id FROM rounds WHERE opens_at <= now() AND closes_at > now() AND status <> 'rolled_over'
  UNION
  SELECT previous.id, previous.previous_round_id FROM rounds previous
  JOIN eligible_rounds current ON previous.id=current.previous_round_id WHERE previous.status='rolled_over'
)`;
const ACTIVITY_WINDOW_HOURS = 48;
const shortWallet = (wallet) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
function roundClosePlan(paidTicketCount, freeTicketCount, winnerPoolAmount) {
  return paidTicketCount >= MIN_PAID_TICKETS_FOR_DRAW
    ? { status: 'locked', paidTicketCount, freeTicketCount, winnerPoolAmount, carriedAmount: '0' }
    : { status: 'rolled_over', paidTicketCount, freeTicketCount, winnerPoolAmount, carriedAmount: winnerPoolAmount };
}
function buildDrawSnapshotContent(round, ledgerEntries) {
  if (Number(round.paid_ticket_count) < MIN_PAID_TICKETS_FOR_DRAW) throw new Error('A round needs at least 10 paid tickets for a draw snapshot.');
  if (!ledgerEntries.length) throw new Error('A draw snapshot needs eligible tickets.');
  const sourceRanges = [...ledgerEntries].sort((left, right) => {
    const leftStart = BigInt(left.source_start_ticket); const rightStart = BigInt(right.source_start_ticket);
    return leftStart < rightStart ? -1 : leftStart > rightStart ? 1 : String(left.ledger_entry_id).localeCompare(String(right.ledger_entry_id));
  });
  let previousSourceEnd = null;
  for (const entry of sourceRanges) {
    const count = Number(entry.ticket_count); const start = BigInt(entry.source_start_ticket); const end = BigInt(entry.source_end_ticket);
    if (!Number.isSafeInteger(count) || count <= 0 || end - start + 1n !== BigInt(count)) throw new Error('Ledger ticket range is invalid.');
    if (previousSourceEnd !== null && start <= previousSourceEnd) throw new Error('Ledger ticket ranges overlap.');
    previousSourceEnd = end;
  }
  let nextTicket = 1n;
  const ranges = ledgerEntries.map((entry, index) => {
    const ticketCount = Number(entry.ticket_count); const startTicket = nextTicket; const endTicket = startTicket + BigInt(ticketCount) - 1n; nextTicket = endTicket + 1n;
    return { sequenceNumber: index + 1, ledgerEntryId: entry.ledger_entry_id, originRoundId: entry.origin_round_id || round.id, participantId: entry.participant_id, payoutWallet: entry.payout_wallet, ticketType: entry.ticket_type, cause: entry.cause, paymentId: entry.payment_id, sourceStartTicket: String(entry.source_start_ticket), sourceEndTicket: String(entry.source_end_ticket), startTicket: startTicket.toString(), endTicket: endTicket.toString(), ticketCount };
  });
  const paidTicketCount = ranges.filter((range) => range.ticketType === 'paid').reduce((sum, range) => sum + range.ticketCount, 0);
  const freeTicketCount = ranges.filter((range) => range.ticketType === 'free').reduce((sum, range) => sum + range.ticketCount, 0);
  if (paidTicketCount !== Number(round.paid_ticket_count) || freeTicketCount !== Number(round.free_ticket_count)) throw new Error('Round ticket totals do not match its ticket ledger.');
  const winnerPoolAmount = String(round.winner_pool_amount); const carryInAmount = String(round.carry_in_amount);
  if (BigInt(winnerPoolAmount) < 0n || BigInt(carryInAmount) < 0n || BigInt(round.gross_pool_amount) < 0n || BigInt(round.organizer_fee_amount) < 0n) throw new Error('Round pool values cannot be negative.');
  const content = { version: 1, roundId: round.id, paidTicketCount, freeTicketCount, totalEligibleTicketCount: paidTicketCount + freeTicketCount, grossPoolAmount: String(round.gross_pool_amount), organizerFeeAmount: String(round.organizer_fee_amount), winnerPoolAmount, carryInAmount, totalWinnerEligibleAmount: (BigInt(winnerPoolAmount) + BigInt(carryInAmount)).toString(), ranges };
  const snapshotHash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return { ...content, snapshotHash };
}
function selectPaymentMatch(exactOrders, aliasOrders) {
  if (exactOrders.length === 1) return { order: exactOrders[0], matchedBy: 'exact' };
  if (exactOrders.length > 1) return { manualReview: true, matchedBy: 'exact' };
  if (aliasOrders.length === 1) return { order: aliasOrders[0], matchedBy: 'alias' };
  if (aliasOrders.length > 1) return { manualReview: true, matchedBy: 'alias' };
  return null;
}

class PostgresRepository {
  constructor(pool, { payoutTarget = () => payoutTargetConfig() } = {}) { this.pool = pool; this.payoutTarget = payoutTarget; }
  async transaction(work) { const client = await this.pool.connect(); try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async roundById(roundId) { const result = await this.pool.query('SELECT * FROM rounds WHERE id = $1', [roundId]); return result.rows[0] || null; }
  async settlementForRound(roundId) { const result = await this.pool.query('SELECT id FROM settlements WHERE round_id = $1', [roundId]); return result.rows[0]?.id || null; }
  async runnableRoundIds(limit = 50) {
    const result = await this.pool.query(`SELECT r.id FROM rounds r LEFT JOIN round_lifecycle_runs l ON l.round_id = r.id
      WHERE (r.status IN ('locked','waiting_for_randomness','winner_selected','settlement_pending','payout_broadcast','payout_retryable')
        OR (r.status = 'open' AND r.closes_at <= now()))
      AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= now())
      ORDER BY r.closes_at ASC LIMIT $1`, [limit]);
    return result.rows.map((row) => row.id);
  }
  async claimRound(roundId, workerId, leaseSeconds = 30) {
    const result = await this.pool.query(`INSERT INTO round_lifecycle_runs (round_id, worker_id, claim_until, updated_at)
      VALUES ($1,$2,now() + ($3 * interval '1 second'),now())
      ON CONFLICT (round_id) DO UPDATE SET worker_id = EXCLUDED.worker_id, claim_until = EXCLUDED.claim_until, updated_at = now()
        WHERE round_lifecycle_runs.claim_until IS NULL OR round_lifecycle_runs.claim_until < now()
      RETURNING round_id`, [roundId, workerId, leaseSeconds]);
    return result.rowCount === 1;
  }
  async recordLifecycleSuccess(roundId, workerId, action) { await this.pool.query(`UPDATE round_lifecycle_runs SET worker_id = NULL, claim_until = NULL, last_action = $3, last_error_code = NULL, last_error_message = NULL, retry_count = 0, next_attempt_at = NULL, last_success_at = now(), updated_at = now() WHERE round_id = $1 AND worker_id = $2`, [roundId, workerId, action]); }
  async recordLifecycleRetry(roundId, workerId, action, errorCode, errorMessage, delaySeconds) { await this.pool.query(`UPDATE round_lifecycle_runs SET worker_id = NULL, claim_until = NULL, last_action = $3, last_error_code = $4, last_error_message = $5, retry_count = retry_count + 1, next_attempt_at = now() + ($6 * interval '1 second'), updated_at = now() WHERE round_id = $1 AND worker_id = $2`, [roundId, workerId, action, errorCode, String(errorMessage || '').slice(0, 1000), delaySeconds]); }
  async recordLifecycleFailure(roundId, workerId, action, errorCode, errorMessage) { await this.pool.query(`UPDATE round_lifecycle_runs SET worker_id = NULL, claim_until = NULL, last_action = $3, last_error_code = $4, last_error_message = $5, next_attempt_at = NULL, updated_at = now() WHERE round_id = $1 AND worker_id = $2`, [roundId, workerId, action, errorCode, String(errorMessage || '').slice(0, 1000)]); }
  async expirePending() { await this.pool.query("UPDATE orders SET payment_status = 'expired' WHERE payment_status = 'pending' AND expires_at <= now()"); }
  async openRound(db, now) {
    const opensAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const closesAt = new Date(opensAt.getTime() + 24 * 60 * 60 * 1000);
    const result = await db.query(`INSERT INTO rounds (id, status, opens_at, closes_at, draw_at, carry_in_amount, gross_pool_amount, organizer_fee_amount, winner_pool_amount, paid_ticket_count, free_ticket_count, created_at, updated_at)
      VALUES ($1, 'open', $2, $3, $3, 0, 0, 0, 0, 0, 0, now(), now())
      ON CONFLICT (opens_at) DO UPDATE SET updated_at = rounds.updated_at
      RETURNING id`, [crypto.randomUUID(), opensAt, closesAt]);
    return result.rows[0].id;
  }
  async roundForTicketIssuance(db, roundId) {
    const assigned = await db.query('SELECT * FROM rounds WHERE id = $1 FOR UPDATE', [roundId]);
    if (!assigned.rowCount) throw new Error('The order has no round.');
    if (assigned.rows[0].status === 'open' && new Date(assigned.rows[0].closes_at) > new Date()) return assigned.rows[0];
    // A confirmed payment which reaches its old round after that round locked
    // belongs to the currently valid successor, never to closed history.
    const currentId = await this.openRound(db, new Date());
    const current = await db.query("SELECT * FROM rounds WHERE id = $1 AND status = 'open' AND opens_at <= now() AND closes_at > now() FOR UPDATE", [currentId]);
    if (!current.rowCount) throw new Error('No open round is available for confirmed payment issuance.');
    return current.rows[0];
  }
  async closeRound(roundId) {
    return this.transaction(async (db) => {
      const locked = await db.query('SELECT * FROM rounds WHERE id = $1 FOR UPDATE', [roundId]);
      if (!locked.rowCount) throw new Error('Round not found.');
      const round = locked.rows[0];
      if (round.status !== 'open') {
        const carry = await db.query('SELECT * FROM round_carry_overs WHERE from_round_id = $1', [roundId]);
        return { roundId, status: round.status, paidTicketCount: Number(round.paid_ticket_count), freeTicketCount: Number(round.free_ticket_count), winnerPoolAmount: String(round.winner_pool_amount), nextRoundId: round.next_round_id, carriedAmount: carry.rows[0] ? String(carry.rows[0].amount) : '0', idempotent: true };
      }
      // Issuance locks this same round before inserting a ledger row, so this
      // read cannot miss a concurrently confirmed ticket.
      const directTotals = await db.query(`SELECT
        COALESCE(SUM(ticket_count) FILTER (WHERE ticket_type = 'paid'), 0)::integer AS paid_tickets,
        COALESCE(SUM(ticket_count) FILTER (WHERE ticket_type = 'free'), 0)::integer AS free_tickets,
        COALESCE(SUM(o.ticket_value_amount) FILTER (WHERE l.ticket_type = 'paid'), 0)::text AS gross_pool
        FROM ticket_ledger_entries l LEFT JOIN orders o ON o.id = l.order_id WHERE l.round_id = $1`, [roundId]);
      const ledger = await this.eligibleLedgerEntries(db, roundId);
      const paidTicketCount = ledger.rows.filter((entry) => entry.ticket_type === 'paid').reduce((sum, entry) => sum + Number(entry.ticket_count), 0);
      const freeTicketCount = ledger.rows.filter((entry) => entry.ticket_type === 'free').reduce((sum, entry) => sum + Number(entry.ticket_count), 0);
      const grossPoolAmount = String(directTotals.rows[0].gross_pool);
      // There is no configured organizer-fee rule in the current product. Keep
      // the stored fee (normally zero) and derive this round's eligible pool
      // solely from its paid payment amounts.
      const organizerFeeAmount = String(round.organizer_fee_amount);
      const winnerPoolAmount = (BigInt(grossPoolAmount) - BigInt(organizerFeeAmount)).toString();
      await db.query(`UPDATE rounds SET status = 'locked', paid_ticket_count = $1, free_ticket_count = $2, gross_pool_amount = $3, winner_pool_amount = $4, updated_at = now() WHERE id = $5`, [paidTicketCount, freeTicketCount, grossPoolAmount, winnerPoolAmount, roundId]);
      const totalWinnerEligibleAmount = (BigInt(winnerPoolAmount) + BigInt(round.carry_in_amount)).toString();
      const plan = roundClosePlan(paidTicketCount, freeTicketCount, totalWinnerEligibleAmount);
      if (plan.status === 'locked') return { roundId, ...plan, nextRoundId: null, idempotent: false };
      let successor = await db.query(`INSERT INTO rounds (id, status, opens_at, closes_at, draw_at, previous_round_id, carry_in_amount, gross_pool_amount, organizer_fee_amount, winner_pool_amount, paid_ticket_count, free_ticket_count, created_at, updated_at)
        VALUES ($1, 'open', $2::timestamptz, $2::timestamptz + interval '1 day', $2::timestamptz + interval '1 day', $3, $4, 0, 0, 0, 0, 0, now(), now())
        ON CONFLICT (opens_at) DO UPDATE SET previous_round_id = EXCLUDED.previous_round_id, carry_in_amount = EXCLUDED.carry_in_amount, updated_at = now()
          WHERE rounds.previous_round_id IS NULL AND rounds.carry_in_amount = 0
        RETURNING id, previous_round_id, carry_in_amount`, [crypto.randomUUID(), round.closes_at, roundId, totalWinnerEligibleAmount]);
      if (!successor.rowCount) successor = await db.query('SELECT id, previous_round_id, carry_in_amount FROM rounds WHERE opens_at = $1 FOR UPDATE', [round.closes_at]);
      const nextRound = successor.rows[0];
      if (nextRound.previous_round_id !== roundId) throw new Error('The successor round is already linked to another round.');
      if (String(nextRound.carry_in_amount) !== totalWinnerEligibleAmount) throw new Error('The successor round already has different carry-over accounting.');
      await db.query(`INSERT INTO round_carry_overs (from_round_id, to_round_id, amount) VALUES ($1,$2,$3)`, [roundId, nextRound.id, totalWinnerEligibleAmount]);
      await db.query("UPDATE rounds SET status = 'rolled_over', next_round_id = $1, updated_at = now() WHERE id = $2", [nextRound.id, roundId]);
      return { roundId, ...plan, nextRoundId: nextRound.id, idempotent: false };
    });
  }
  async createDrawSnapshot(roundId) {
    return this.transaction(async (db) => {
      const result = await db.query('SELECT * FROM rounds WHERE id = $1 FOR UPDATE', [roundId]);
      if (!result.rowCount) throw new Error('Round not found.');
      const round = result.rows[0];
      const existing = await db.query('SELECT * FROM draw_snapshots WHERE round_id = $1', [roundId]);
      if (existing.rowCount) return this.drawSnapshotById(db, existing.rows[0].id, true);
      if (round.status !== 'locked') throw new Error('Only a locked draw-eligible round can receive a draw snapshot.');
      const ledger = await this.eligibleLedgerEntries(db, roundId);
      const snapshot = buildDrawSnapshotContent(round, ledger.rows);
      const snapshotId = crypto.randomUUID();
      const savedSnapshot = await db.query(`INSERT INTO draw_snapshots (id, round_id, snapshot_hash, paid_ticket_count, free_ticket_count, total_eligible_ticket_count, gross_pool_amount, organizer_fee_amount, winner_pool_amount, carry_in_amount, total_winner_eligible_amount)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING created_at`, [snapshotId, roundId, snapshot.snapshotHash, snapshot.paidTicketCount, snapshot.freeTicketCount, snapshot.totalEligibleTicketCount, snapshot.grossPoolAmount, snapshot.organizerFeeAmount, snapshot.winnerPoolAmount, snapshot.carryInAmount, snapshot.totalWinnerEligibleAmount]);
      for (const range of snapshot.ranges) await db.query(`INSERT INTO draw_snapshot_ranges (id, snapshot_id, sequence_number, ledger_entry_id, origin_round_id, participant_id, payout_wallet, ticket_type, cause, payment_id, source_start_ticket, source_end_ticket, start_ticket, end_ticket, ticket_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [crypto.randomUUID(), snapshotId, range.sequenceNumber, range.ledgerEntryId, range.originRoundId, range.participantId, range.payoutWallet, range.ticketType, range.cause, range.paymentId, range.sourceStartTicket, range.sourceEndTicket, range.startTicket, range.endTicket, range.ticketCount]);
      const commitment = drandCommitmentFor(savedSnapshot.rows[0].created_at);
      await db.query(`INSERT INTO drand_commitments (id, snapshot_id, round_id, snapshot_finalized_at, network_id, chain_hash, public_key, scheme_id, genesis_time, period_seconds, drand_round, scheduled_at, algorithm_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [crypto.randomUUID(), snapshotId, roundId, savedSnapshot.rows[0].created_at, commitment.id, commitment.chainHash, commitment.publicKey, commitment.schemeId, commitment.genesisTime, commitment.periodSeconds, commitment.round, commitment.scheduledAt, commitment.algorithmVersion]);
      await db.query("UPDATE rounds SET status = 'waiting_for_randomness', updated_at = now() WHERE id = $1", [roundId]);
      return this.drawSnapshotById(db, snapshotId, false);
    });
  }
  async eligibleLedgerEntries(db, roundId) {
    return db.query(`WITH RECURSIVE eligibility_rounds AS (
        SELECT id, previous_round_id, 0 AS depth FROM rounds WHERE id = $1
        UNION ALL
        SELECT previous.id, previous.previous_round_id, eligibility_rounds.depth + 1
        FROM rounds previous JOIN eligibility_rounds ON previous.id = eligibility_rounds.previous_round_id
        WHERE previous.status = 'rolled_over'
      )
      SELECT l.id AS ledger_entry_id, l.round_id AS origin_round_id, l.participant_id, p.payout_wallet, l.payment_id, l.ticket_type, l.cause, l.ticket_count, l.start_ticket AS source_start_ticket, l.end_ticket AS source_end_ticket
      FROM eligibility_rounds e JOIN ticket_ledger_entries l ON l.round_id = e.id JOIN participants p ON p.id = l.participant_id
      ORDER BY l.start_ticket ASC, l.id ASC`, [roundId]);
  }
  async drawSnapshotById(db, snapshotId, idempotent) {
    const snapshot = await db.query('SELECT * FROM draw_snapshots WHERE id = $1', [snapshotId]);
    const ranges = await db.query('SELECT * FROM draw_snapshot_ranges WHERE snapshot_id = $1 ORDER BY sequence_number', [snapshotId]);
    const row = snapshot.rows[0];
    const commitment = await db.query('SELECT * FROM drand_commitments WHERE snapshot_id = $1', [snapshotId]);
    return { id: row.id, roundId: row.round_id, snapshotHash: row.snapshot_hash, finalizedAt: row.created_at, paidTicketCount: Number(row.paid_ticket_count), freeTicketCount: Number(row.free_ticket_count), totalEligibleTicketCount: Number(row.total_eligible_ticket_count), grossPoolAmount: String(row.gross_pool_amount), organizerFeeAmount: String(row.organizer_fee_amount), winnerPoolAmount: String(row.winner_pool_amount), carryInAmount: String(row.carry_in_amount), totalWinnerEligibleAmount: String(row.total_winner_eligible_amount), drandCommitment: commitment.rows[0] ? { id: commitment.rows[0].id, networkId: commitment.rows[0].network_id, chainHash: commitment.rows[0].chain_hash, drandRound: String(commitment.rows[0].drand_round), scheduledAt: commitment.rows[0].scheduled_at, algorithmVersion: commitment.rows[0].algorithm_version } : null, ranges: ranges.rows.map((range) => ({ id: range.id, sequenceNumber: range.sequence_number, ledgerEntryId: range.ledger_entry_id, originRoundId: range.origin_round_id, participantId: range.participant_id, payoutWallet: range.payout_wallet, ticketType: range.ticket_type, cause: range.cause, paymentId: range.payment_id, sourceStartTicket: String(range.source_start_ticket), sourceEndTicket: String(range.source_end_ticket), startTicket: String(range.start_ticket), endTicket: String(range.end_ticket), ticketCount: Number(range.ticket_count) })), idempotent };
  }
  async getDrandCommitment(roundId) {
    const result = await this.pool.query(`SELECT c.*, r.status, result.id AS result_id FROM drand_commitments c JOIN rounds r ON r.id = c.round_id LEFT JOIN draw_results result ON result.commitment_id = c.id WHERE c.round_id = $1`, [roundId]);
    if (!result.rowCount) throw new Error('Round has no drand commitment.');
    const row = result.rows[0];
    return { id: row.id, roundId, snapshotId: row.snapshot_id, drandRound: String(row.drand_round), scheduledAt: row.scheduled_at, networkId: row.network_id, chainHash: row.chain_hash, algorithmVersion: row.algorithm_version, resultId: row.result_id, status: row.status };
  }
  async recordVerifiedDrandResult(roundId, beacon) {
    return this.transaction(async (db) => {
      const commitment = await db.query('SELECT * FROM drand_commitments WHERE round_id = $1 FOR UPDATE', [roundId]);
      if (!commitment.rowCount) throw new Error('Round has no drand commitment.');
      const row = commitment.rows[0]; const existing = await db.query('SELECT id FROM draw_results WHERE commitment_id = $1', [row.id]);
      if (existing.rowCount) return this.drawResultById(db, existing.rows[0].id, true);
      if (String(beacon.round) !== String(row.drand_round)) throw new Error('drand beacon round differs from the committed round.');
      if (!/^[0-9a-f]{64}$/i.test(beacon.randomness) || !/^[0-9a-f]+$/i.test(beacon.signature || '')) throw new Error('drand beacon has invalid material.');
      const snapshot = await this.drawSnapshotById(db, row.snapshot_id, false);
      const selection = winningTicketFromRandomness(beacon.randomness, snapshot.totalEligibleTicketCount);
      const winningRange = resolveSnapshotRange(snapshot.ranges, selection.winningTicket);
      const resultId = crypto.randomUUID();
      await db.query(`INSERT INTO draw_results (id, round_id, snapshot_id, commitment_id, network_id, chain_hash, drand_round, scheduled_at, randomness, signature, algorithm_version, rejection_counter, total_eligible_ticket_count, winning_ticket, winning_snapshot_range_id, winner_participant_id, winner_payout_wallet)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [resultId, roundId, row.snapshot_id, row.id, row.network_id, row.chain_hash, row.drand_round, row.scheduled_at, beacon.randomness.toLowerCase(), beacon.signature.toLowerCase(), row.algorithm_version, selection.rejectionCounter, snapshot.totalEligibleTicketCount, selection.winningTicket, winningRange.id, winningRange.participantId, winningRange.payoutWallet]);
      await db.query("UPDATE rounds SET status = 'winner_selected', updated_at = now() WHERE id = $1", [roundId]);
      return this.drawResultById(db, resultId, false);
    });
  }
  async drawResult(roundId, idempotent) { const result = await this.pool.query('SELECT id FROM draw_results WHERE round_id = $1', [roundId]); if (!result.rowCount) throw new Error('Draw result is not available.'); return this.drawResultById(this.pool, result.rows[0].id, idempotent); }
  async drawResultById(db, resultId, idempotent) {
    const result = await db.query('SELECT * FROM draw_results WHERE id = $1', [resultId]); const row = result.rows[0];
    return { id: row.id, roundId: row.round_id, snapshotId: row.snapshot_id, commitmentId: row.commitment_id, networkId: row.network_id, chainHash: row.chain_hash, drandRound: String(row.drand_round), scheduledAt: row.scheduled_at, randomness: row.randomness, signature: row.signature, algorithmVersion: row.algorithm_version, rejectionCounter: String(row.rejection_counter), totalEligibleTicketCount: Number(row.total_eligible_ticket_count), winningTicket: String(row.winning_ticket), winningSnapshotRangeId: row.winning_snapshot_range_id, winnerParticipantId: row.winner_participant_id, winnerPayoutWallet: row.winner_payout_wallet, resolvedAt: row.resolved_at, idempotent };
  }
  async createSettlement(roundId) {
    return this.transaction(async (db) => {
      // Capturing the approved test target here freezes the payout destination
      // before a signer is ever asked to create a transaction.
      const payoutTarget = this.payoutTarget();
      const round = await db.query('SELECT * FROM rounds WHERE id = $1 FOR UPDATE', [roundId]); if (!round.rowCount) throw new Error('Round not found.');
      const existing = await db.query('SELECT * FROM settlements WHERE round_id = $1', [roundId]); if (existing.rowCount) return this.settlementById(db, existing.rows[0].id, true);
      if (round.rows[0].status !== 'winner_selected') throw new Error('Settlement requires an immutable winner-selected round.');
      const result = await db.query('SELECT * FROM draw_results WHERE round_id = $1', [roundId]); if (!result.rowCount) throw new Error('Round has no immutable draw result.');
      const snapshot = await db.query('SELECT * FROM draw_snapshots WHERE id = $1', [result.rows[0].snapshot_id]); const frozen = snapshot.rows[0]; const amounts = settlementAmounts(frozen.total_winner_eligible_amount);
      const settlementId = crypto.randomUUID();
      await db.query(`INSERT INTO settlements (id, round_id, draw_result_id, winner_wallet, settlement_basis, organizer_fee_accrued, winner_amount, carry_in_amount, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`, [settlementId, roundId, result.rows[0].id, result.rows[0].winner_payout_wallet, amounts.settlementBasis, amounts.organizerFee, amounts.winnerAmount, frozen.carry_in_amount]);
      await db.query(`INSERT INTO payout_intents (id, settlement_id, winner_wallet, winner_amount, chain_id, token_address, status) VALUES ($1,$2,$3,$4,$5,$6,'pending')`, [crypto.randomUUID(), settlementId, result.rows[0].winner_payout_wallet, amounts.winnerAmount, payoutTarget.chainId, payoutTarget.tokenAddress.toLowerCase()]);
      await db.query("UPDATE rounds SET status = 'settlement_pending', updated_at = now() WHERE id = $1", [roundId]);
      return this.settlementById(db, settlementId, false);
    });
  }
  async settlementById(db, settlementId, idempotent) {
    const settlement = await db.query('SELECT * FROM settlements WHERE id = $1', [settlementId]); const row = settlement.rows[0]; const intent = await db.query('SELECT * FROM payout_intents WHERE settlement_id = $1', [settlementId]);
    return { id: row.id, roundId: row.round_id, drawResultId: row.draw_result_id, winnerWallet: row.winner_wallet, settlementBasis: String(row.settlement_basis), organizerFeeAccrued: String(row.organizer_fee_accrued), winnerAmount: String(row.winner_amount), carryInAmount: String(row.carry_in_amount), status: row.status, retryCount: row.retry_count, payoutIntent: intent.rowCount ? this.publicPayoutIntent(intent.rows[0]) : null, idempotent };
  }
  publicPayoutIntent(row) { return { id: row.id, settlementId: row.settlement_id, winnerWallet: row.winner_wallet, winnerAmount: String(row.winner_amount), chainId: Number(row.chain_id), tokenAddress: row.token_address, senderWallet: row.sender_wallet, nonce: row.nonce === null ? null : String(row.nonce), transactionHash: row.transaction_hash, status: row.status, broadcastAt: row.broadcast_at, confirmedAt: row.confirmed_at, confirmedBlockNumber: row.confirmed_block_number, networkFeeWei: row.network_fee_wei === null ? null : String(row.network_fee_wei) }; }
  async payoutIntent(settlementId) { const result = await this.pool.query('SELECT * FROM payout_intents WHERE settlement_id = $1', [settlementId]); if (!result.rowCount) throw new Error('Settlement has no payout intent.'); return { ...this.publicPayoutIntent(result.rows[0]), token_address: result.rows[0].token_address, signedTransaction: result.rows[0].signed_transaction }; }
  async preparePayout(settlementId, provider) {
    return this.transaction(async (db) => {
      const intent = await db.query('SELECT i.*, s.status AS settlement_status FROM payout_intents i JOIN settlements s ON s.id = i.settlement_id WHERE i.settlement_id = $1 FOR UPDATE', [settlementId]); if (!intent.rowCount) throw new Error('Settlement has no payout intent.'); const row = intent.rows[0];
      if (row.status === 'confirmed' || row.status === 'broadcast' || row.signed_transaction) return { ...this.publicPayoutIntent(row), token_address: row.token_address, signedTransaction: row.signed_transaction };
      let signed;
      try { signed = await provider.signTransfer({ recipient: row.winner_wallet, amount: String(row.winner_amount) }); }
      catch (error) { const failureCode = error?.code === 'insufficient_test_token' || error?.code === 'insufficient_native_gas' ? error.code : 'signing_failed'; await db.query("UPDATE payout_intents SET status = 'retryable', failure_code = $1, updated_at = now() WHERE id = $2", [failureCode, row.id]); await db.query("UPDATE settlements SET status = 'retryable', retry_count = retry_count + 1, failure_code = $1, updated_at = now() WHERE id = $2", [failureCode, settlementId]); return { ...this.publicPayoutIntent({ ...row, status: 'retryable' }), token_address: row.token_address, signedTransaction: null }; }
      if (Number(signed.chainId) !== Number(row.chain_id) || signed.token.toLowerCase() !== row.token_address || signed.recipient.toLowerCase() !== row.winner_wallet.toLowerCase() || String(signed.amount) !== String(row.winner_amount)) throw new Error('Payout signer produced a transaction that differs from its intent.');
      await db.query(`UPDATE payout_intents SET sender_wallet = $1, nonce = $2, gas_limit = $3, gas_price = $4, signed_transaction = $5, transaction_hash = $6, status = 'signed', failure_code = NULL, failure_message = NULL, updated_at = now() WHERE id = $7`, [signed.sender, signed.nonce, signed.gasLimit, signed.gasPrice, signed.signedTransaction, signed.transactionHash, row.id]);
      const saved = await db.query('SELECT * FROM payout_intents WHERE id = $1', [row.id]); return { ...this.publicPayoutIntent(saved.rows[0]), token_address: saved.rows[0].token_address, signedTransaction: saved.rows[0].signed_transaction };
    });
  }
  async executePayout(settlementId, provider) {
    const prepared = await this.preparePayout(settlementId, provider); if (!prepared.signedTransaction || prepared.status === 'confirmed' || prepared.status === 'broadcast') return prepared;
    return this.transaction(async (db) => {
      const intent = await db.query('SELECT * FROM payout_intents WHERE settlement_id = $1 FOR UPDATE', [settlementId]); const row = intent.rows[0]; if (row.status === 'confirmed' || row.status === 'broadcast') return this.publicPayoutIntent(row);
      try { await provider.recoverOrBroadcast({ ...this.publicPayoutIntent(row), token_address: row.token_address, signedTransaction: row.signed_transaction }); }
      catch { await db.query("UPDATE payout_intents SET status = 'retryable', failure_code = 'broadcast_ambiguous', updated_at = now() WHERE id = $1", [row.id]); await db.query("UPDATE settlements SET status = 'retryable', retry_count = retry_count + 1, failure_code = 'broadcast_ambiguous', updated_at = now() WHERE id = $1", [settlementId]); const retry = await db.query('SELECT * FROM payout_intents WHERE id = $1', [row.id]); return this.publicPayoutIntent(retry.rows[0]); }
      await db.query("UPDATE payout_intents SET status = 'broadcast', broadcast_at = COALESCE(broadcast_at, now()), failure_code = NULL, updated_at = now() WHERE id = $1", [row.id]); await db.query("UPDATE settlements SET status = 'broadcast', updated_at = now() WHERE id = $1", [settlementId]); await db.query("UPDATE rounds SET status = 'payout_broadcast', updated_at = now() WHERE id = (SELECT round_id FROM settlements WHERE id = $1)", [settlementId]); const saved = await db.query('SELECT * FROM payout_intents WHERE id = $1', [row.id]); return this.publicPayoutIntent(saved.rows[0]);
    });
  }
  async confirmPayout(settlementId, verification) {
    if (!verification.confirmed) return this.settlementById(this.pool, settlementId, true);
    return this.transaction(async (db) => {
      const intent = await db.query('SELECT * FROM payout_intents WHERE settlement_id = $1 FOR UPDATE', [settlementId]); const row = intent.rows[0]; if (row.status === 'confirmed') return this.settlementById(db, settlementId, true);
      if (row.status !== 'broadcast') throw new Error('Only a broadcast payout may be confirmed.');
      await db.query("UPDATE payout_intents SET status = 'confirmed', confirmed_at = now(), confirmed_block_number = $1, network_fee_wei = $2, updated_at = now() WHERE id = $3", [verification.blockNumber, verification.networkFeeWei, row.id]); await db.query("UPDATE settlements SET status = 'confirmed', confirmed_at = now(), updated_at = now() WHERE id = $1", [settlementId]); await db.query("UPDATE rounds SET status = 'completed', updated_at = now() WHERE id = (SELECT round_id FROM settlements WHERE id = $1)", [settlementId]); return this.settlementById(db, settlementId, false);
    });
  }
  async createOrder(data, participantId) {
    return this.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('oneofus-payment-code-allocation'))");
      await db.query('UPDATE payment_code_reservations SET active = false WHERE active AND cooldown_until <= now()');
      await db.query('UPDATE payment_amount_reservations SET active = false WHERE active AND cooldown_until <= now()');
      await db.query('UPDATE payment_identifier_reservations SET active = false WHERE active AND cooldown_until <= now()');
      const participantResult = await db.query(`INSERT INTO participants (id, name, payout_wallet) VALUES ($1, $2, $3) ON CONFLICT (payout_wallet) DO UPDATE SET name = CASE WHEN EXCLUDED.name <> 'Anonymous' THEN EXCLUDED.name ELSE participants.name END, updated_at = now() RETURNING id, name, payout_wallet`, [crypto.randomUUID(), data.participantName, data.payoutWallet]);
      const participant = participantResult.rows[0]; const now = new Date(); const expiresAt = new Date(now.getTime() + PAYMENT_RESERVATION_MINUTES * 60_000); const cooldownUntil = new Date(now.getTime() + (PAYMENT_RESERVATION_MINUTES + PAYMENT_CODE_COOLDOWN_MINUTES) * 60_000);
      for (let code = 1; ; code += 1) {
        let identifier; let expected;
        try { identifier = paymentIdentifierFor(code); expected = amountFor(data.ticketQuantity, code).toString(); } catch { break; }
        const reservedAmounts = paymentAmountsFor(data.ticketQuantity, code);
        const taken = await db.query('SELECT 1 FROM payment_amount_reservations WHERE active AND amount = ANY($1::numeric[]) LIMIT 1', [reservedAmounts.map(({ amount }) => amount.toString())]); if (taken.rowCount) continue;
        const id = crypto.randomUUID(); const ticketValue = (BigInt(data.ticketQuantity) * tokenUnits).toString();
        const roundId = await this.openRound(db, now);
        await db.query(`INSERT INTO orders (id, participant_id, round_id, ticket_quantity, sending_source, base_ticket_amount, ticket_value_amount, identification_amount, payment_code, expected_payment_amount, payment_status, created_at, expires_at, cooldown_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13)`, [id, participant.id, roundId, data.ticketQuantity, data.sendingSource, String(data.ticketQuantity), ticketValue, (BigInt(expected) - BigInt(ticketValue)).toString(), code, expected, now, expiresAt, cooldownUntil]);
        await db.query(`INSERT INTO payment_code_reservations (id, order_id, full_expected_amount, payment_code, status, reserved_at, expires_at, cooldown_until) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7)`, [crypto.randomUUID(), id, expected, code, now, expiresAt, cooldownUntil]);
        for (const reservation of reservedAmounts) await db.query(`INSERT INTO payment_amount_reservations (id, order_id, amount, kind, reserved_at, expires_at, cooldown_until) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [crypto.randomUUID(), id, reservation.amount.toString(), reservation.kind, now, expiresAt, cooldownUntil]);
        await db.query(`INSERT INTO payment_identifier_reservations (id, order_id, base_amount, identifier, reserved_at, expires_at, cooldown_until) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [crypto.randomUUID(), id, String(data.ticketQuantity), identifier, now, expiresAt, cooldownUntil]);
        return this.orderById(db, id);
      }
      throw new Error('No payment identifiers are currently available. Please try again shortly.');
    });
  }
  async orderById(db, id) { const result = await db.query(`SELECT o.*, p.name AS participant_name, p.payout_wallet FROM orders o JOIN participants p ON p.id = o.participant_id WHERE o.id = $1`, [id]); return result.rows[0] || null; }
  async getOrder(id) { return this.orderById(this.pool, id); }
  async recordTransfer(log, { tokenAddress, receivingAddress }) {
    return this.transaction(async (db) => {
      const key = [log.transactionHash.toLowerCase(), Number.parseInt(log.logIndex, 16)]; const amount = BigInt(log.data).toString(); const payment = await db.query(`INSERT INTO payments (id, transaction_hash, log_index, block_number, token_address, from_address, to_address, received_amount, detected_at, payment_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),'unmatched') ON CONFLICT (transaction_hash) DO NOTHING RETURNING id`, [crypto.randomUUID(), key[0], key[1], Number.parseInt(log.blockNumber, 16), tokenAddress.toLowerCase(), log.topics?.[1] ? `0x${log.topics[1].slice(-40)}` : null, receivingAddress.toLowerCase(), amount]);
      if (!payment.rowCount) return null;
      const eligible = `((o.payment_status = 'pending' AND o.expires_at > now()) OR (o.payment_status = 'expired' AND o.cooldown_until > now()) OR o.payment_status IN ('payment_detected', 'paid'))`;
      // Exact reservations are deliberately queried first. An alias can never
      // override a real order whose expected amount equals the transfer.
      const exact = await db.query(`SELECT o.*, r.kind FROM payment_amount_reservations r JOIN orders o ON o.id = r.order_id WHERE r.active AND r.amount = $1 AND r.kind = 'exact' AND ${eligible} FOR UPDATE OF o, r`, [amount]);
      const aliases = exact.rowCount ? { rows: [] } : await db.query(`SELECT o.*, r.kind FROM payment_amount_reservations r JOIN orders o ON o.id = r.order_id WHERE r.active AND r.amount = $1 AND r.kind = 'alias' AND ${eligible} FOR UPDATE OF o, r`, [amount]);
      const match = selectPaymentMatch(exact.rows, aliases.rows);
      if (!match) return { status: 'unmatched' };
      if (match.manualReview) { await db.query("UPDATE payments SET payment_status = 'manual_review', matched_by = $1 WHERE id = $2", [match.matchedBy, payment.rows[0].id]); return { status: 'manual_review' }; }
      const { order, matchedBy } = match;
      let status = 'duplicate_payment';
      if (order.payment_status === 'pending') { status = 'payment_detected'; await db.query(`UPDATE orders SET payment_status = 'payment_detected', transaction_hash = $1, transaction_log_index = $2, block_number = $3, received_amount = $4 WHERE id = $5`, [key[0], key[1], Number.parseInt(log.blockNumber, 16), amount, order.id]); }
      else if (order.payment_status === 'expired') { status = 'late_payment'; await db.query(`UPDATE orders SET payment_status = 'late_payment', transaction_hash = $1, transaction_log_index = $2, block_number = $3, received_amount = $4 WHERE id = $5`, [key[0], key[1], Number.parseInt(log.blockNumber, 16), amount, order.id]); }
      await db.query('UPDATE payments SET order_id = $1, payment_status = $2, matched_by = $3, expected_amount = $4, matched_amount = $5 WHERE id = $6', [order.id, status, matchedBy, order.expected_payment_amount, amount, payment.rows[0].id]); return { status, orderId: order.id, matchedBy };
    });
  }
  async confirmPayments(head, confirmations) {
    return this.transaction(async (db) => {
      const orders = await db.query(`SELECT * FROM orders WHERE payment_status = 'payment_detected' AND $1 - block_number + 1 >= $2 FOR UPDATE`, [head, confirmations]);
      if (!orders.rowCount) return [];
      const counter = await db.query("SELECT next_value FROM app_counters WHERE name = 'ticket' FOR UPDATE"); let next = BigInt(counter.rows[0].next_value); const completed = [];
      for (const order of orders.rows) {
        const round = await this.roundForTicketIssuance(db, order.round_id);
        const start = next; const end = start + BigInt(order.ticket_quantity) - 1n; next = end + 1n;
        await db.query(`UPDATE orders SET round_id = $1, payment_status = 'paid', paid_at = now(), cooldown_until = now() + ($2 * interval '1 minute'), ticket_range_start = $3, ticket_range_end = $4 WHERE id = $5`, [round.id, PAYMENT_CODE_COOLDOWN_MINUTES, start.toString(), end.toString(), order.id]);
        await db.query(`INSERT INTO ticket_ranges (id, order_id, participant_id, round_id, start_ticket, end_ticket, created_at) VALUES ($1,$2,$3,$4,$5,$6,now())`, [crypto.randomUUID(), order.id, order.participant_id, round.id, start.toString(), end.toString()]);
        const payment = await db.query("UPDATE payments SET confirmed_at = now(), payment_status = 'confirmed' WHERE order_id = $1 AND payment_status = 'payment_detected' RETURNING id", [order.id]);
        await db.query(`INSERT INTO ticket_ledger_entries (id, round_id, order_id, participant_id, payment_id, ticket_type, cause, ticket_count, start_ticket, end_ticket, created_at) VALUES ($1,$2,$3,$4,$5,'paid','payment_confirmation',$6,$7,$8,now())`, [crypto.randomUUID(), round.id, order.id, order.participant_id, payment.rows[0]?.id || null, order.ticket_quantity, start.toString(), end.toString()]);
        await db.query("UPDATE payment_code_reservations SET status = 'paid', cooldown_until = now() + ($1 * interval '1 minute') WHERE order_id = $2", [PAYMENT_CODE_COOLDOWN_MINUTES, order.id]);
        await db.query("UPDATE payment_amount_reservations SET cooldown_until = now() + ($1 * interval '1 minute') WHERE order_id = $2 AND active", [PAYMENT_CODE_COOLDOWN_MINUTES, order.id]);
        await db.query("UPDATE rounds SET paid_ticket_count = paid_ticket_count + $1, gross_pool_amount = gross_pool_amount + $2, winner_pool_amount = winner_pool_amount + $2, updated_at = now() WHERE id = $3", [order.ticket_quantity, order.ticket_value_amount, round.id]);
        completed.push(order.id);
      }
      await db.query("UPDATE app_counters SET next_value = $1 WHERE name = 'ticket'", [next.toString()]); return completed;
    });
  }
  async getScannerBlock(name) { const result = await this.pool.query('SELECT last_processed_block FROM scanner_state WHERE scanner_name = $1', [name]); return result.rows[0]?.last_processed_block ?? null; }
  async setScannerBlock(name, block) { await this.pool.query(`INSERT INTO scanner_state (scanner_name, last_processed_block, updated_at) VALUES ($1,$2,now()) ON CONFLICT (scanner_name) DO UPDATE SET last_processed_block = EXCLUDED.last_processed_block, updated_at = now()`, [name, block]); }
  async siteSummary() { const pool = await this.pool.query(`${activeEligibilitySql} SELECT COALESCE(SUM(l.ticket_count), 0)::text AS tickets FROM ticket_ledger_entries l JOIN eligible_rounds r ON r.id=l.round_id WHERE l.ticket_type='paid'`); const activity = await this.pool.query(`SELECT o.id, p.name, p.payout_wallet, o.ticket_quantity, o.paid_at FROM orders o JOIN participants p ON p.id = o.participant_id WHERE o.payment_status = 'paid' AND o.paid_at >= now() - ($1 * interval '1 hour') ORDER BY o.paid_at DESC LIMIT 6`, [ACTIVITY_WINDOW_HOURS]); const draws = await this.draws(4); const tickets = pool.rows[0].tickets; return { currentPool: { paidTickets: Number(tickets), amount: tickets, minPaidTicketsForDraw: MIN_PAID_TICKETS_FOR_DRAW }, activity: activity.rows.map((row) => ({ id: row.id, name: row.name !== 'Anonymous' ? row.name : shortWallet(row.payout_wallet), tickets: row.ticket_quantity, paidAt: row.paid_at })), lastWinner: draws[0] || null, recentWinners: draws }; }
  async participantEntries(id) { const participant = await this.pool.query('SELECT id, name, payout_wallet FROM participants WHERE id = $1', [id]); if (!participant.rowCount) return null; const orders = await this.pool.query(`${activeEligibilitySql} SELECT l.ticket_count AS ticket_quantity, l.start_ticket AS ticket_range_start, l.end_ticket AS ticket_range_end FROM ticket_ledger_entries l JOIN eligible_rounds r ON r.id=l.round_id WHERE l.participant_id=$1 ORDER BY l.start_ticket`, [id]); return { participant: { id, displayName: participant.rows[0].name, payoutWallet: shortWallet(participant.rows[0].payout_wallet) }, tickets: orders.rows.reduce((sum, row) => sum + row.ticket_quantity, 0), ranges: orders.rows.map((row) => ({ start: Number(row.ticket_range_start), end: Number(row.ticket_range_end) })) }; }
  async verifyDraw(roundId) {
    const round = await this.pool.query('SELECT id, status, opens_at, closes_at FROM rounds WHERE id = $1', [roundId]); if (!round.rowCount) return null;
    const row = await this.pool.query(`SELECT s.id AS snapshot_id,s.snapshot_hash,s.created_at AS entries_locked_at,s.paid_ticket_count,s.free_ticket_count,s.total_eligible_ticket_count,c.network_id,c.chain_hash,c.drand_round,c.scheduled_at,d.id AS result_id,d.resolved_at,d.randomness,d.algorithm_version,d.winning_ticket,d.winner_payout_wallet,x.id AS settlement_id,x.winner_amount,x.status AS settlement_status,i.status AS payout_status,i.transaction_hash
      FROM draw_snapshots s LEFT JOIN drand_commitments c ON c.snapshot_id=s.id LEFT JOIN draw_results d ON d.round_id=s.round_id LEFT JOIN settlements x ON x.round_id=s.round_id LEFT JOIN payout_intents i ON i.settlement_id=x.id WHERE s.round_id=$1`, [roundId]);
    if (!row.rowCount || !row.rows[0].result_id || !row.rows[0].randomness) return { roundId, status: 'unavailable', reason: row.rowCount ? 'verification_not_available' : 'snapshot_not_available' };
    const value = row.rows[0]; return { status: 'verified', roundId, roundState: round.rows[0].status, entriesLockedAt: value.entries_locked_at, drawnAt: value.resolved_at, totalEligibleTickets: Number(value.total_eligible_ticket_count), paidTicketCount: Number(value.paid_ticket_count), freeTicketCount: Number(value.free_ticket_count), snapshotHash: value.snapshot_hash, drand: { network: value.network_id, chainHash: value.chain_hash, round: String(value.drand_round), scheduledAt: value.scheduled_at }, publicRandomness: value.randomness, algorithmVersion: value.algorithm_version, winningTicket: String(value.winning_ticket), winnerWallet: value.winner_payout_wallet, prizeAmount: value.winner_amount === null ? null : String(value.winner_amount), payout: value.settlement_id ? { status: value.payout_status || value.settlement_status, transactionHash: value.payout_status === 'confirmed' ? value.transaction_hash : null } : null };
  }
  async draws(limit = 10) { const completed = await this.pool.query(`SELECT r.id,r.updated_at AS draw_date,d.winner_payout_wallet,d.winning_ticket,x.winner_amount FROM rounds r JOIN draw_results d ON d.round_id=r.id JOIN settlements x ON x.round_id=r.id WHERE r.status='completed' ORDER BY r.updated_at DESC LIMIT $1`, [limit]); if (completed.rowCount) return completed.rows.map((row) => ({ id: row.id, roundId: row.id, drawDate: row.draw_date, winnerName: shortWallet(row.winner_payout_wallet), winnerWallet: shortWallet(row.winner_payout_wallet), winningTicketNumber: Number(row.winning_ticket), prizeAmount: (BigInt(row.winner_amount) / tokenUnits).toString(), isDemo: false })); const result = await this.pool.query(`SELECT * FROM draw_history WHERE status = 'completed' AND ($1::boolean OR is_demo = false) ORDER BY draw_date DESC LIMIT $2`, [process.env.NODE_ENV !== 'production', limit]); return result.rows.map((row) => ({ id: row.id, roundId: null, drawDate: row.draw_date, winnerName: row.winner_name, winnerWallet: shortWallet(row.winner_payout_wallet), winningTicketNumber: Number(row.winning_ticket_number), prizeAmount: (BigInt(row.prize_amount) / tokenUnits).toString(), isDemo: row.is_demo })); }
}
module.exports = { PostgresRepository, selectPaymentMatch, roundClosePlan, buildDrawSnapshotContent };
