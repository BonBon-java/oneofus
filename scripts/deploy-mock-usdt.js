'use strict';

const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const { ethers } = require('ethers');

const RPC_URL = 'http://127.0.0.1:8545';
// Hardhat's documented deterministic development account. It is used only by
// this ignored local integration environment, never by application defaults.
const PAYOUT_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WINNER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function compile() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'MockUSDT.sol'), 'utf8');
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'MockUSDT.sol': { content: source } }, settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  if (output.errors?.some((entry) => entry.severity === 'error')) throw new Error(output.errors.map((entry) => entry.formattedMessage).join('\n'));
  return output.contracts['MockUSDT.sol'].MockUSDT;
}

async function deployMockUsdt() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  if (network.chainId !== 31337n) throw new Error('Local MockUSDT deployment requires chain ID 31337.');
  // Deployment and initial mint are sent back-to-back on an automining node.
  // Keep their nonce allocation local and monotonic instead of depending on a
  // provider's just-cached transaction-count response.
  const signer = new ethers.NonceManager(new ethers.Wallet(PAYOUT_PRIVATE_KEY, provider));
  const artifact = compile();
  const token = await new ethers.ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer).deploy();
  await token.waitForDeployment();
  await (await token.mint(await signer.getAddress(), 1_000_000_000_000n)).wait();
  return { tokenAddress: await token.getAddress(), payoutPrivateKey: PAYOUT_PRIVATE_KEY, winnerAddress: await new ethers.Wallet(WINNER_PRIVATE_KEY).getAddress() };
}

async function main() {
  const deployed = await deployMockUsdt();
  const envFile = path.join(__dirname, '..', '.env.integration.local');
  fs.writeFileSync(envFile, [
    'DATABASE_URL=postgresql://oneofus:local-integration-only@127.0.0.1:5434/oneofus_integration',
    'ONE_OF_US_PAYOUT_MODE=testnet', 'ONE_OF_US_PAYOUT_RPC_URL=http://127.0.0.1:8545', 'ONE_OF_US_PAYOUT_CHAIN_ID=31337',
    `ONE_OF_US_PAYOUT_TOKEN_ADDRESS=${deployed.tokenAddress}`, 'ONE_OF_US_PAYOUT_TOKEN_DECIMALS=6',
    `ONE_OF_US_PAYOUT_PRIVATE_KEY=${deployed.payoutPrivateKey}`, `PAYOUT_TEST_WINNER_ADDRESS=${deployed.winnerAddress}`,
    'PAYOUT_TEST_AMOUNT_UNITS=1000001', 'PAYMENT_CONFIRMATIONS=1', 'RUN_PAYOUT_INTEGRATION_TESTS=true', '',
  ].join('\n'), { mode: 0o600 });
  console.log(`MockUSDT deployed locally: ${deployed.tokenAddress}`);
  return deployed;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { deployMockUsdt };
