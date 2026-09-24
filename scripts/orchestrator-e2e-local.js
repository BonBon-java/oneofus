'use strict';
const fs = require('node:fs'); const path = require('node:path'); const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const envFrom = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)));
const start = spawnSync(process.execPath, ['scripts/local-integration.js', 'start'], { cwd: root, stdio: 'inherit' });
if (start.status !== 0) process.exit(start.status || 1);
const result = spawnSync(process.execPath, ['--test', 'tests/orchestrator.e2e.test.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, ...envFrom(path.join(root, '.env.integration.local')), RUN_ORCHESTRATOR_E2E: 'true' } });
process.exitCode = result.status || 0;
