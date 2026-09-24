'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { ethers } = require('ethers');
const { deployMockUsdt } = require('./deploy-mock-usdt.js');
const { USDT_TOKEN_ADDRESS } = require('../payment-domain.js');
const root = path.join(__dirname, '..');
const runtime = path.join(root, '.local-integration');
const pidFile = path.join(runtime, 'hardhat.pid');
const run = (command, args, env) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.`);
};
async function rpcReady() { try { return (await new ethers.JsonRpcProvider('http://127.0.0.1:8545').getNetwork()).chainId === 31337n; } catch { return false; } }
async function start() {
  if (process.env.ONE_OF_US_PAYOUT_CHAIN_ID === '42161' || process.env.ONE_OF_US_PAYOUT_MODE && process.env.ONE_OF_US_PAYOUT_MODE !== 'testnet' || process.env.ONE_OF_US_PAYOUT_TOKEN_ADDRESS?.toLowerCase() === USDT_TOKEN_ADDRESS.toLowerCase()) {
    throw new Error('Local integration refuses mainnet, production USDT, or a non-testnet payout mode.');
  }
  run('docker', ['compose', '-f', 'compose.integration.yaml', 'up', '-d', '--wait']);
  if (!(await rpcReady())) {
    fs.mkdirSync(runtime, { recursive: true });
    const log = fs.openSync(path.join(runtime, 'hardhat.log'), 'a');
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['hardhat', 'node', '--config', 'scripts/hardhat.integration.config.js'], { cwd: root, detached: true, stdio: ['ignore', log, log] });
    child.unref(); fs.writeFileSync(pidFile, String(child.pid));
    for (let attempt = 0; attempt < 120 && !(await rpcReady()); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!(await rpcReady())) throw new Error('Hardhat local chain did not become ready on http://127.0.0.1:8545.');
  const envFile = path.join(root, '.env.integration.local');
  const existing = fs.existsSync(envFile) ? Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2))) : null;
  const existingCode = existing?.ONE_OF_US_PAYOUT_TOKEN_ADDRESS ? await new ethers.JsonRpcProvider('http://127.0.0.1:8545').getCode(existing.ONE_OF_US_PAYOUT_TOKEN_ADDRESS) : '0x';
  if (existingCode === '0x') await deployMockUsdt().then(async (deployed) => {
    fs.writeFileSync(envFile, [
      'DATABASE_URL=postgresql://oneofus:local-integration-only@127.0.0.1:5434/oneofus_integration', 'ONE_OF_US_PAYOUT_MODE=testnet', 'ONE_OF_US_PAYOUT_RPC_URL=http://127.0.0.1:8545', 'ONE_OF_US_PAYOUT_CHAIN_ID=31337', `ONE_OF_US_PAYOUT_TOKEN_ADDRESS=${deployed.tokenAddress}`, 'ONE_OF_US_PAYOUT_TOKEN_DECIMALS=6', `ONE_OF_US_PAYOUT_PRIVATE_KEY=${deployed.payoutPrivateKey}`, `PAYOUT_TEST_WINNER_ADDRESS=${deployed.winnerAddress}`, 'PAYOUT_TEST_AMOUNT_UNITS=1000001', 'PAYMENT_CONFIRMATIONS=1', 'RUN_PAYOUT_INTEGRATION_TESTS=true', '',
    ].join('\n'), { mode: 0o600 });
    console.log(`MockUSDT deployed locally: ${deployed.tokenAddress}`);
  });
  else {
    // The chain can be reused while the Compose port/configuration changes.
    // Refresh only the disposable database endpoint; keep the local token and
    // deterministic test credentials already generated for this chain.
    existing.DATABASE_URL = 'postgresql://oneofus:local-integration-only@127.0.0.1:5434/oneofus_integration';
    existing.PAYOUT_TEST_WINNER_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    fs.writeFileSync(envFile, `${Object.entries(existing).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  }
  const integrationEnv = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  run(process.execPath, ['scripts/migrate.js'], integrationEnv);
  console.log('Local integration stack ready: PostgreSQL PASS, Local EVM PASS, MockUSDT deployment PASS.');
}
function reset() {
  if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch {} fs.rmSync(pidFile, { force: true }); }
  run('docker', ['compose', '-f', 'compose.integration.yaml', 'down', '-v']);
  fs.rmSync(path.join(root, '.env.integration.local'), { force: true });
  console.log('Local integration state reset.');
}
const command = process.argv[2];
(command === 'start' ? start() : command === 'reset' ? Promise.resolve(reset()) : Promise.reject(new Error('Use start or reset.'))).catch((error) => { console.error(error.message); process.exitCode = 1; });
