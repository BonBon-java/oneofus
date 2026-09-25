'use strict';
const { ethers } = require('ethers');
const { AwsKmsEthereumSigner, createAwsKmsClient } = require('../aws-kms-signer.js');
async function main() {
  const { AWS_REGION: region, AWS_KMS_KEY_ID: keyId, PAYOUT_EXPECTED_SIGNER_ADDRESS: expectedAddress, AWS_KMS_EXPECTED_KEY_ARN: expectedKeyArn } = process.env;
  if (!region || !keyId || !expectedAddress || !expectedKeyArn) throw new Error('AWS_REGION, AWS_KMS_KEY_ID, AWS_KMS_EXPECTED_KEY_ARN and PAYOUT_EXPECTED_SIGNER_ADDRESS are required.');
  const signer = new AwsKmsEthereumSigner({ kms: createAwsKmsClient({ region }), keyId, expectedAddress, region, expectedKeyArn });
  const identity = await signer.identity();
  // This static digest has no settlement, account or transaction content.
  const digest = ethers.keccak256(ethers.toUtf8Bytes('oneofus-kms-smoke-v1:no-economic-authority'));
  const signature = await signer.signDigest(digest);
  console.log(JSON.stringify({ status: 'ok', signer: identity.address, region, keyArn: identity.keyArn, recovered: ethers.recoverAddress(digest, signature), digest }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
