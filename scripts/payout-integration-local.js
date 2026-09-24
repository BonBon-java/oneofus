'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
function envFrom(file) { return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2))); }
async function main() {
  const start = spawnSync(process.execPath, ['scripts/local-integration.js', 'start'], { cwd: root, stdio: 'inherit' });
  if (start.status !== 0) process.exit(start.status || 1);
  const result = spawnSync(process.execPath, ['--test', 'tests/payout.integration.test.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, ...envFrom(path.join(root, '.env.integration.local')) } });
  process.exitCode = result.status || 0;
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
