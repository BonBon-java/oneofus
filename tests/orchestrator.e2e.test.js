'use strict';
const crypto = require('node:crypto'); const test = require('node:test'); const assert = require('node:assert/strict');
const { Pool } = require('pg'); const { ethers } = require('ethers');
const { migrate } = require('../db.js'); const { PostgresRepository } = require('../postgres-repository.js'); const { EthersTestnetPayoutProvider, TRANSFER_ABI } = require('../payout-provider.js'); const { SettlementService } = require('../settlement-service.js'); const { DrandWinnerService } = require('../drand-winner-service.js'); const { RoundLifecycleOrchestrator } = require('../round-lifecycle-orchestrator.js');

const enabled = process.env.RUN_ORCHESTRATOR_E2E === 'true';
test('orchestrator E2E: OPEN to COMPLETED with PostgreSQL, deterministic drand and real MockUSDT', { skip: !enabled && 'run npm run test:orchestrator-e2e:local' }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL }); await migrate(pool);
  await pool.query('TRUNCATE TABLE rounds, participants, app_counters CASCADE'); await pool.query("INSERT INTO app_counters (name,next_value) VALUES ('ticket',1)");
  const repository = new PostgresRepository(pool); const payout = new EthersTestnetPayoutProvider(); const config = await payout.validateNetworkAndToken(); const winner = ethers.getAddress(process.env.PAYOUT_TEST_WINNER_ADDRESS); const token = new ethers.Contract(config.token, TRANSFER_ABI, payout.provider);
  const id = Object.fromEntries(['round','participant','order','payment','ledger'].map((key) => [key, crypto.randomUUID()])); const total = '10000000'; const opens = new Date(Date.now() - 172800000); const closes = new Date(Date.now() - 86400000);
  await pool.query("INSERT INTO participants (id,name,payout_wallet) VALUES ($1,'Orchestrator E2E winner',$2)", [id.participant, winner]);
  await pool.query("INSERT INTO rounds (id,status,opens_at,closes_at,draw_at,carry_in_amount,gross_pool_amount,organizer_fee_amount,winner_pool_amount,paid_ticket_count,free_ticket_count) VALUES ($1,'open',$2,$3,$3,0,0,0,0,0,0)", [id.round, opens, closes]);
  await pool.query("INSERT INTO orders (id,participant_id,round_id,ticket_quantity,sending_source,base_ticket_amount,ticket_value_amount,identification_amount,payment_code,expected_payment_amount,payment_status,created_at,expires_at,cooldown_until,paid_at) VALUES ($1,$2,$3,10,'local',10,$4,0,1,$4,'paid',now(),now(),now(),now())", [id.order,id.participant,id.round,total]);
  await pool.query("INSERT INTO payments (id,order_id,transaction_hash,log_index,block_number,token_address,to_address,received_amount,detected_at,confirmed_at,payment_status) VALUES ($1,$2,$3,0,1,$4,$5,$6,now(),now(),'confirmed')", [id.payment,id.order,`0x${crypto.randomBytes(32).toString('hex')}`,config.token,winner,total]);
  await pool.query("INSERT INTO ticket_ledger_entries (id,round_id,order_id,participant_id,payment_id,ticket_type,cause,ticket_count,start_ticket,end_ticket) VALUES ($1,$2,$3,$4,$5,'paid','e2e_fixture',10,1,10)", [id.ledger,id.round,id.order,id.participant,id.payment]);
  const unavailableClient = { fetchRound: async () => { throw new Error('drand network timeout'); } };
  const settlementService = new SettlementService(repository, () => payout);
  const first = new RoundLifecycleOrchestrator({ repository, drandService: new DrandWinnerService(repository, unavailableClient), settlementService, retrySeconds: 0, logger: null });
  const waiting = await first.processRound(id.round); assert.equal(waiting.action, 'RETRY');
  const beforeRestart = await pool.query('SELECT status FROM rounds WHERE id=$1',[id.round]); assert.equal(beforeRestart.rows[0].status, 'waiting_for_randomness');
  const commitment = await pool.query('SELECT * FROM drand_commitments WHERE round_id=$1',[id.round]); assert.equal(commitment.rowCount,1); const committedRound = String(commitment.rows[0].drand_round);
  const beacon = { round: committedRound, randomness: '0'.repeat(64), signature: '01' }; const availableClient = { fetchRound: async (round) => { assert.equal(String(round), committedRound); return beacon; } };
  const signerBefore = await token.balanceOf(config.sender); const winnerBefore = await token.balanceOf(winner);
  const workerA = new RoundLifecycleOrchestrator({ repository, drandService: new DrandWinnerService(repository, availableClient), settlementService, retrySeconds: 0, logger: null }); const workerB = new RoundLifecycleOrchestrator({ repository, drandService: new DrandWinnerService(repository, availableClient), settlementService, retrySeconds: 0, logger: null });
  await Promise.all([workerA.processRound(id.round), workerB.processRound(id.round)]);
  const round = await pool.query('SELECT status FROM rounds WHERE id=$1',[id.round]); assert.equal(round.rows[0].status,'completed');
  const snapshot = await pool.query('SELECT * FROM draw_snapshots WHERE round_id=$1',[id.round]); const result = await pool.query('SELECT * FROM draw_results WHERE round_id=$1',[id.round]); const settlement = await pool.query('SELECT * FROM settlements WHERE round_id=$1',[id.round]); const legs = await pool.query("SELECT * FROM settlement_legs WHERE settlement_id=$1 ORDER BY CASE kind WHEN 'winner_payout' THEN 1 ELSE 2 END",[settlement.rows[0].id]);
  assert.equal(snapshot.rowCount,1); assert.equal(snapshot.rows[0].paid_ticket_count,10); assert.equal(snapshot.rows[0].free_ticket_count,0); assert.equal(snapshot.rows[0].total_eligible_ticket_count,10); assert.match(snapshot.rows[0].snapshot_hash,/^[0-9a-f]{64}$/);
  assert.equal(result.rowCount,1); assert.equal(String(result.rows[0].winning_ticket),'1'); assert.equal(result.rows[0].winner_participant_id,id.participant); assert.equal(ethers.getAddress(result.rows[0].winner_payout_wallet),winner); assert.equal(result.rows[0].algorithm_version,'ONE_OF_US_DRAND_V1');
  assert.equal(settlement.rowCount,1); assert.equal(String(settlement.rows[0].settlement_basis),total); assert.equal(String(settlement.rows[0].organizer_fee_accrued),'1500000'); assert.equal(String(settlement.rows[0].winner_amount),'8500000'); assert.equal(settlement.rows[0].status,'settled');
  assert.equal(legs.rowCount,2); for (const leg of legs.rows) { assert.equal(leg.status,'confirmed'); assert.ok(leg.transaction_hash); const receipt=await payout.provider.getTransactionReceipt(leg.transaction_hash); assert.equal(receipt.status,1); }
  assert.equal((await token.balanceOf(winner))-winnerBefore,8500000n); assert.equal(signerBefore-(await token.balanceOf(config.sender)),10000000n);
  const verification = await repository.verifyDraw(id.round); assert.equal(verification.status,'verified'); assert.equal(verification.winningTicket,'1'); assert.equal(verification.publicRandomness,beacon.randomness);
  const winnerAfter = await token.balanceOf(winner); await workerA.processRound(id.round); await workerB.processRound(id.round); assert.equal(await token.balanceOf(winner),winnerAfter);
  console.log(`ORCHESTRATOR_E2E round=${id.round} drand=${committedRound} tx=${legs.rows.map((leg)=>leg.transaction_hash).join(',')}`); await pool.end();
});
