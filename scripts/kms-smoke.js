'use strict';
const { ethers } = require('ethers');
const { AwsKmsEthereumSigner, createAwsKmsClient } = require('../aws-kms-signer.js');
async function main() {
  const { AWS_REGION: region, AWS_KMS_KEY_ID: keyId, PAYOUT_EXPECTED_SIGNER_ADDRESS: expectedAddress } = process.env;
  if (!region || !keyId || !expectedAddress) throw new Error('AWS_REGION, AWS_KMS_KEY_ID and PAYOUT_EXPECTED_SIGNER_ADDRESS are required.');
  const signer = new AwsKmsEthereumSigner({ kms: createAwsKmsClient({ region }), keyId, expectedAddress, region });
  const identity = await signer.identity(); const digest = ethers.keccak256(ethers.toUtf8Bytes('oneofus-kms-smoke-v1')); const signature = await signer.signDigest(digest);
  console.log(JSON.stringify({ status: 'ok', signer: identity.address, region, recovered: ethers.recoverAddress(digest, signature) }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
