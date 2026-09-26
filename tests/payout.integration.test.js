'use strict';
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { ethers } = require('ethers');
const { migrate } = require('../db.js');
const { PostgresRepository } = require('../postgres-repository.js');
const { SettlementService } = require('../settlement-service.js');
const { EthersTestnetPayoutProvider, TRANSFER_ABI, PayoutPreflightError } = require('../payout-provider.js');

const enabled = process.env.RUN_PAYOUT_INTEGRATION_TESTS === 'true';
test('real PostgreSQL + local EVM payout lifecycle', { skip: !enabled && 'run npm run test:payout-integration:local' }, async (t) => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL }); await migrate(pool);
  await pool.query('TRUNCATE TABLE rounds, participants, app_counters CASCADE'); await pool.query("INSERT INTO app_counters (name, next_value) VALUES ('ticket', 1)");
  // Hardhat mines synchronously: cached block numbers can leave waitForTransaction
  // waiting for another block even though the receipt already exists.
  const rpc = new ethers.JsonRpcProvider(process.env.ONE_OF_US_PAYOUT_RPC_URL, undefined, { cacheTimeout: -1 });
  t.after(() => rpc.destroy());
  const repository = new PostgresRepository(pool); const provider = new EthersTestnetPayoutProvider({ provider: rpc }); const config = await provider.validateNetworkAndToken();
  const token = new ethers.Contract(config.token, TRANSFER_ABI, provider.provider); const winner = ethers.getAddress(process.env.PAYOUT_TEST_WINNER_ADDRESS); let sequence = 0;
  async function seedWinnerSelected() {
    sequence += 1; const id = Object.fromEntries(['round','participant','order','payment','ledger','snapshot','range','commitment','result'].map((name) => [name, crypto.randomUUID()]));
    const opens = new Date(Date.UTC(2030, 0, sequence)); const closes = new Date(opens.getTime() + 86400000); const total = '10000000';
    const participant = await pool.query("INSERT INTO participants (id,name,payout_wallet) VALUES ($1,'Local winner',$2) ON CONFLICT (payout_wallet) DO UPDATE SET name = EXCLUDED.name RETURNING id", [id.participant, winner]); id.participant = participant.rows[0].id;
    await pool.query("INSERT INTO rounds (id,status,opens_at,closes_at,draw_at,carry_in_amount,gross_pool_amount,organizer_fee_amount,winner_pool_amount,paid_ticket_count,free_ticket_count) VALUES ($1,'open',$2,$3,$3,0,$4,0,$4,10,0)", [id.round, opens, closes, total]);
    await pool.query("INSERT INTO orders (id,participant_id,round_id,ticket_quantity,sending_source,base_ticket_amount,ticket_value_amount,identification_amount,payment_code,expected_payment_amount,payment_status,created_at,expires_at,cooldown_until,paid_at) VALUES ($1,$2,$3,10,'local',10,$4,0,1,$4,'paid',now(),now(),now(),now())", [id.order,id.participant,id.round,total]);
    await pool.query("INSERT INTO payments (id,order_id,transaction_hash,log_index,block_number,token_address,to_address,received_amount,detected_at,confirmed_at,payment_status) VALUES ($1,$2,$3,0,1,$4,$5,$6,now(),now(),'confirmed')", [id.payment,id.order,`0x${crypto.randomBytes(32).toString('hex')}`,config.token,winner,total]);
    await pool.query("INSERT INTO ticket_ledger_entries (id,round_id,order_id,participant_id,payment_id,ticket_type,cause,ticket_count,start_ticket,end_ticket) VALUES ($1,$2,$3,$4,$5,'paid','local_integration',10,$6,$7)", [id.ledger,id.round,id.order,id.participant,id.payment,sequence * 100,sequence * 100 + 9]);
    await pool.query("UPDATE rounds SET status = 'locked' WHERE id = $1", [id.round]);
    await pool.query("INSERT INTO draw_snapshots (id,round_id,snapshot_hash,paid_ticket_count,free_ticket_count,total_eligible_ticket_count,gross_pool_amount,organizer_fee_amount,winner_pool_amount,carry_in_amount,total_winner_eligible_amount) VALUES ($1,$2,$3,10,0,10,$4,0,$4,0,$4)", [id.snapshot,id.round,crypto.randomBytes(32).toString('hex'),total]);
    await pool.query("INSERT INTO draw_snapshot_ranges (origin_round_id, id,snapshot_id,sequence_number,ledger_entry_id,participant_id,payout_wallet,ticket_type,cause,payment_id,source_start_ticket,source_end_ticket,start_ticket,end_ticket,ticket_count) VALUES ($9,$1,$2,1,$3,$4,$5,'paid','local_integration',$6,$7,$8,1,10,10)", [id.range,id.snapshot,id.ledger,id.participant,winner,id.payment,sequence * 100,sequence * 100 + 9,id.round]);
    await pool.query("INSERT INTO drand_commitments (id,snapshot_id,round_id,snapshot_finalized_at,network_id,chain_hash,public_key,scheme_id,genesis_time,period_seconds,drand_round,scheduled_at,algorithm_version) VALUES ($1,$2,$3,now(),'local',$4,'local','local',1,1,1,now() + interval '1 second','local')", [id.commitment,id.snapshot,id.round,crypto.randomBytes(32).toString('hex')]);
    await pool.query("INSERT INTO draw_results (id,round_id,snapshot_id,commitment_id,network_id,chain_hash,drand_round,scheduled_at,randomness,signature,algorithm_version,rejection_counter,total_eligible_ticket_count,winning_ticket,winning_snapshot_range_id,winner_participant_id,winner_payout_wallet) VALUES ($1,$2,$3,$4,'local',$5,1,now(),$6,'00','local',0,10,1,$7,$8,$9)", [id.result,id.round,id.snapshot,id.commitment,crypto.randomBytes(32).toString('hex'),crypto.randomBytes(32).toString('hex'),id.range,id.participant,winner]);
    await pool.query("UPDATE rounds SET status = 'winner_selected' WHERE id = $1", [id.round]); return id.round;
  }
  const service = () => new SettlementService(repository, () => provider);
  async function settle(settlementId, instance = service()) { const winnerConfirmed = await instance.confirmPayout(settlementId); assert.equal(winnerConfirmed.status, 'winner_confirmed'); const treasurySubmitted = await instance.executePayout(settlementId); assert.equal(treasurySubmitted.status, 'treasury_submitted'); const settled = await instance.confirmPayout(settlementId); assert.equal(settled.status, 'settled'); return settled; }
  await t.test('happy path and PostgreSQL settlement uniqueness', async () => {
    const round = await seedWinnerSelected(); const [created, repeated] = await Promise.all([service().createSettlement(round),service().createSettlement(round)]); assert.equal(created.id,repeated.id);
    const count = await pool.query('SELECT count(*)::integer AS settlements FROM settlements WHERE round_id=$1',[round]); assert.equal(count.rows[0].settlements,1);
    const winnerAmount=BigInt(created.winnerAmount), treasuryAmount=BigInt(created.treasuryAmount), treasury=process.env.TREASURY_WALLET_ADDRESS, senderBefore=await token.balanceOf(config.sender), winnerBefore=await token.balanceOf(winner), treasuryBefore=await token.balanceOf(treasury); const broadcast=await service().executePayout(created.id); assert.equal(broadcast.status,'winner_submitted'); const settled=await settle(created.id);
    assert.equal((await token.balanceOf(winner))-winnerBefore,winnerAmount); assert.equal((await token.balanceOf(treasury))-treasuryBefore,treasuryAmount); assert.equal(senderBefore-(await token.balanceOf(config.sender)),winnerAmount+treasuryAmount); assert.equal((await pool.query('SELECT status FROM rounds WHERE id=$1',[round])).rows[0].status,'completed'); console.log(`LOCAL_TX_HAPPY=${settled.legs.map((leg)=>leg.transactionHash).join(',')}`);
  });
  await t.test('concurrent workers broadcast exactly once', async () => {
    const settlement=await service().createSettlement(await seedWinnerSelected()); let sends=0; const counted=Object.create(provider); counted.recoverOrBroadcast=async (intent)=>{sends+=1;return provider.recoverOrBroadcast(intent);}; const concurrent=new SettlementService(repository,()=>counted);
    const [a,b]=await Promise.all([concurrent.executePayout(settlement.id),concurrent.executePayout(settlement.id)]); assert.equal(sends,1); assert.equal(a.legs[0].transactionHash,b.legs[0].transactionHash); await settle(settlement.id,concurrent); console.log(`LOCAL_TX_CONCURRENT=${a.legs[0].transactionHash}`);
  });
  await t.test('crash after real broadcast recovers signed transaction without a second payment', async () => {
    const settlement=await service().createSettlement(await seedWinnerSelected()); const before=await token.balanceOf(winner); const submitted=await service().executePayout(settlement.id); const winnerHash=submitted.legs[0].transactionHash;
    const afterRestart=service(); const recovered=await afterRestart.executePayout(settlement.id); assert.equal(recovered.legs[0].transactionHash,winnerHash); await settle(settlement.id,afterRestart); assert.equal((await token.balanceOf(winner))-before,BigInt(settlement.winnerAmount)); console.log(`LOCAL_TX_RECOVERED=${winnerHash}`);
  });
  await t.test('confirmation retry avoids rebroadcast and preflight failures fail closed', async () => {
    const settlement=await service().createSettlement(await seedWinnerSelected()); let sends=0; const counted=Object.create(provider); counted.recoverOrBroadcast=async (intent)=>{sends+=1;return provider.recoverOrBroadcast(intent);}; const retryService=new SettlementService(repository,()=>counted); await retryService.executePayout(settlement.id);
    assert.equal((await repository.confirmNextSettlementLeg(settlement.id,{confirmed:false})).status,'winner_submitted'); assert.equal(sends,1); await settle(settlement.id,retryService); assert.equal(sends,2);
    const isolatedTarget={chainId:31337,tokenAddress:config.token,decimals:6}; const fundedNoToken=new EthersTestnetPayoutProvider({target:isolatedTarget,privateKey:'0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'}); await assert.rejects(fundedNoToken.signTransfer({recipient:winner,amount:'1'}),(error)=>error instanceof PayoutPreflightError && error.code==='insufficient_test_token');
    const noGasWallet=ethers.Wallet.createRandom(); await (await new ethers.Contract(config.token,['function mint(address,uint256)'],provider.wallet).mint(noGasWallet.address,10n)).wait(); const noGas=new EthersTestnetPayoutProvider({target:isolatedTarget,privateKey:noGasWallet.privateKey}); await assert.rejects(noGas.signTransfer({recipient:winner,amount:'1'}),(error)=>error instanceof PayoutPreflightError && error.code==='insufficient_native_gas');
    const wrongRecipient=await provider.signTransfer({recipient:config.sender,amount:'1'}); await provider.recoverOrBroadcast(wrongRecipient); await provider.provider.waitForTransaction(wrongRecipient.transactionHash,1,30000);
    await assert.rejects(provider.verifyTransfer({chainId:31337,tokenAddress:config.token,senderWallet:config.sender,winnerWallet:winner,winnerAmount:'1',transactionHash:wrongRecipient.transactionHash},1),/expected MockUSDT transfer/);
    const wrongAmount=await provider.signTransfer({recipient:winner,amount:'1'}); await provider.recoverOrBroadcast(wrongAmount); await provider.provider.waitForTransaction(wrongAmount.transactionHash,1,30000);
    await assert.rejects(provider.verifyTransfer({chainId:31337,tokenAddress:config.token,senderWallet:config.sender,winnerWallet:winner,winnerAmount:'2',transactionHash:wrongAmount.transactionHash},1),/expected MockUSDT transfer/);
  });
  await pool.end();
});
