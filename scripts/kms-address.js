'use strict';

const { createAwsKmsClient, inspectKmsPublicKey } = require('../aws-kms-signer.js');

async function main() {
  const { AWS_REGION: region, AWS_KMS_KEY_ID: keyId, AWS_KMS_EXPECTED_KEY_ARN: expectedKeyArn } = process.env;
  if (!region || !keyId) throw new Error('AWS_REGION and AWS_KMS_KEY_ID are required.');
  const identity = await inspectKmsPublicKey({ kms: createAwsKmsClient({ region }), keyId, region, expectedKeyArn });
  console.log(JSON.stringify({ status: 'ok', address: identity.address, region, keyArn: identity.keyArn }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
