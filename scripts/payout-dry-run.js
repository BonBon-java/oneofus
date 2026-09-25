'use strict';
const { createDatabase, migrate } = require('../db.js');
const { PostgresRepository } = require('../postgres-repository.js');
const { SettlementService } = require('../settlement-service.js');

async function main() {
  const settlementId = process.argv[2]; if (!/^[0-9a-f-]{36}$/i.test(settlementId || '')) throw new Error('Usage: node scripts/payout-dry-run.js <settlement-uuid>');
  if (process.env.ONE_OF_US_ENV === 'production') throw new Error('Production dry-run requires a configured external signer adapter; this raw-key test tool is disabled.');
  const pool = createDatabase(); try { await migrate(pool); const service = new SettlementService(new PostgresRepository(pool)); const result = await service.dryRunPayout(settlementId, { maxAmount: process.env.MAX_SINGLE_PAYOUT_BASE_UNITS || undefined, minGasBalanceWei: process.env.MIN_GAS_BALANCE_WEI || undefined, maxGasPriceWei: process.env.MAX_GAS_PRICE_WEI || undefined }); console.log(JSON.stringify(result, null, 2)); } finally { await pool.end(); }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
