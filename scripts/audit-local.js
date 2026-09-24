'use strict';
// Reuse the existing local stack, but isolate destructive test fixtures from
// both public data and other suites. Keep schemas for inspection after a run.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
async function main() {
  const local = Object.fromEntries(fs.readFileSync('.env.integration.local', 'utf8').split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  const url = new URL(local.DATABASE_URL);
  if (url.hostname !== '127.0.0.1' || url.port !== '5434' || url.pathname !== '/oneofus_integration' || local.ONE_OF_US_PAYOUT_RPC_URL !== 'http://127.0.0.1:8545') throw new Error('Audit requires the existing disposable local stack.');
  const pool = new Pool({ connectionString: local.DATABASE_URL });
  const files = process.argv.slice(2);
  const suites = files.length ? files : fs.readdirSync('tests').filter((name) => name.endsWith('.test.js')).map((name) => `tests/${name}`);
  let failed = false;
  try {
    for (const [index, file] of suites.entries()) {
      const schema = `audit_${Date.now()}_${index}`;
      await pool.query(`CREATE SCHEMA ${schema}`);
      console.log(`AUDIT_SCHEMA ${file}: ${schema}`);
      const env = { ...process.env, ...local, PGOPTIONS: `-c search_path=${schema}`, ROUND_TEST_DATABASE_URL: local.DATABASE_URL, RUN_ORCHESTRATOR_E2E: 'true', RUN_DRAND_INTEGRATION: '1', RUN_PAYMENT_E2E: 'true' };
      const browser = file.endsWith('.spec.js');
      const result = spawnSync(process.execPath, browser ? ['node_modules/@playwright/test/cli.js', 'test', file] : ['--test', file], { env, stdio: 'inherit', timeout: 180000 });
      if (result.status !== 0) { failed = true; console.error(`FAILED ${file}: ${result.error?.message || result.status}`); }
    }
  } finally { await pool.end(); }
  process.exitCode = failed ? 1 : 0;
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
