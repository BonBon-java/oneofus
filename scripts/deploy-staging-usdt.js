'use strict';

const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const { ethers } = require('ethers');

const CHAIN_ID = 421614;
const sourcePath = path.join(__dirname, '..', 'tests', 'fixtures', 'OneOfUsStagingUSDT.sol');

function compile() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'OneOfUsStagingUSDT.sol': { content: source } }, settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const errors = (output.errors || []).filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));
  return output.contracts['OneOfUsStagingUSDT.sol'].OneOfUsStagingUSDT;
}

async function deploy({ env = process.env } = {}) {
  if (!env.STAGING_DEPLOYER_PRIVATE_KEY) throw new Error('STAGING_DEPLOYER_PRIVATE_KEY is required and must be a disposable staging-only key.');
  if (!env.ARBITRUM_RPC_URL) throw new Error('ARBITRUM_RPC_URL is required.');
  const provider = new ethers.JsonRpcProvider(env.ARBITRUM_RPC_URL);
  const network = await provider.getNetwork();
  const allowLocal = env.ALLOW_LOCAL_STAGING_TOKEN === 'true';
  if (network.chainId !== BigInt(CHAIN_ID) && !(allowLocal && network.chainId === 31337n)) throw new Error(`Refusing deployment on chain ${network.chainId}; expected Arbitrum Sepolia (${CHAIN_ID}).`);
  const signer = new ethers.Wallet(env.STAGING_DEPLOYER_PRIVATE_KEY, provider);
  const artifact = compile();
  const token = await new ethers.ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer).deploy();
  await token.waitForDeployment();
  const address = await token.getAddress(); const code = await provider.getCode(address);
  const [decimals, name, symbol] = await Promise.all([token.decimals(), token.name(), token.symbol()]);
  if (code === '0x' || Number(decimals) !== 6 || name !== 'OneOfUs Staging USDT' || symbol !== 'sUSDT') throw new Error('Deployed staging token metadata verification failed.');
  const deployment = { network: network.chainId === BigInt(CHAIN_ID) ? 'Arbitrum Sepolia' : 'local test only', chainId: Number(network.chainId), token: { address, name, symbol, decimals: Number(decimals) }, deployer: await signer.getAddress(), transactionHash: token.deploymentTransaction().hash, deployedAt: new Date().toISOString() };
  if (env.ONE_OF_US_DEPLOYMENT_FILE) { const file = path.resolve(env.ONE_OF_US_DEPLOYMENT_FILE); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 }); }
  return deployment;
}

if (require.main === module) deploy().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { CHAIN_ID, compile, deploy };
