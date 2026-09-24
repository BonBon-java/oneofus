'use strict';
const { createDatabase, migrate } = require('../db.js');
const { PostgresRepository } = require('../postgres-repository.js');
const { RoundLifecycleOrchestrator } = require('../round-lifecycle-orchestrator.js');

async function main() {
  const roundId = process.argv[2];
  if (!/^[0-9a-f-]{36}$/i.test(roundId || '')) throw new Error('Usage: npm run round:process -- <round-uuid>');
  const pool = createDatabase();
  try { await migrate(pool); console.log(await new RoundLifecycleOrchestrator({ repository: new PostgresRepository(pool) }).processRound(roundId)); }
  finally { await pool.end(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
