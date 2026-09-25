'use strict';
const { ethers } = require('ethers');
const { ethereumAddressFromSpki, recoverKmsSignature } = require('./kms-ethereum.js');

const KMS_KEY_SPEC = 'ECC_SECG_P256K1';
const KMS_KEY_USAGE = 'SIGN_VERIFY';
const KMS_SIGNING_ALGORITHM = 'ECDSA_SHA_256';

function createAwsKmsClient({ region }) {
  if (!region) throw new Error('AWS KMS region must be explicit.');
  // Uses the normal AWS SDK credential provider chain: workload identity,
  // environment, profile or instance role. Access keys are never read from
  // One of Us configuration files.
  const { KMSClient, DescribeKeyCommand, GetPublicKeyCommand, SignCommand } = require('@aws-sdk/client-kms');
  const client = new KMSClient({ region });
  return {
    describeKey: (input) => client.send(new DescribeKeyCommand(input)),
    getPublicKey: (input) => client.send(new GetPublicKeyCommand(input)),
    sign: (input) => client.send(new SignCommand(input))
  };
}

function keyMetadata(response) { return response.KeyMetadata || response.keyMetadata || response; }
function assertKmsKeyMetadata(metadata, region, expectedKeyArn) {
  if (metadata.KeyState !== 'Enabled') throw new Error(`KMS key must be enabled; received ${metadata.KeyState || 'no KeyState'}.`);
  if (metadata.KeySpec !== KMS_KEY_SPEC) throw new Error(`KMS key must use ${KMS_KEY_SPEC}; received ${metadata.KeySpec || 'no KeySpec'}.`);
  if (metadata.KeyUsage !== KMS_KEY_USAGE) throw new Error(`KMS key must use ${KMS_KEY_USAGE}; received ${metadata.KeyUsage || 'no KeyUsage'}.`);
  if (!metadata.SigningAlgorithms?.includes(KMS_SIGNING_ALGORITHM)) throw new Error(`KMS key must support ${KMS_SIGNING_ALGORITHM}.`);
  const keyRegion = /^arn:[^:]+:kms:([^:]+):/.exec(metadata.Arn || '')?.[1];
  if (!keyRegion || keyRegion !== region) throw new Error('KMS key ARN region does not match the explicit signer region.');
  if (expectedKeyArn && metadata.Arn !== expectedKeyArn) throw new Error('KMS key ARN does not match the configured key ARN.');
}

async function inspectKmsPublicKey({ kms, keyId, region, expectedAddress, expectedKeyArn }) {
  if (!kms?.describeKey || !kms?.getPublicKey || !keyId || !region) throw new Error('KMS inspection requires DescribeKey, GetPublicKey, key id and explicit region.');
  const described = keyMetadata(await kms.describeKey({ KeyId: keyId }));
  assertKmsKeyMetadata(described, region, expectedKeyArn);
  const publicKey = await kms.getPublicKey({ KeyId: keyId });
  assertKmsKeyMetadata({ ...described, KeySpec: publicKey.KeySpec, KeyUsage: publicKey.KeyUsage, SigningAlgorithms: publicKey.SigningAlgorithms }, region, expectedKeyArn);
  const address = ethereumAddressFromSpki(publicKey.PublicKey || publicKey.publicKey);
  if (expectedAddress && address !== ethers.getAddress(expectedAddress)) throw new Error('KMS derived address does not match configured signer address.');
  return { address, provider: 'aws-kms', region, keyArn: described.Arn, signingAlgorithm: KMS_SIGNING_ALGORITHM };
}

// The client is injected so this module is testable without AWS credentials. In
// deployment it is an AWS SDK v3 KMS client with GetPublicKeyCommand/SignCommand.
class AwsKmsEthereumSigner {
  constructor({ kms, keyId, expectedAddress, region, expectedKeyArn }) { if (!kms?.describeKey || !kms?.getPublicKey || !kms?.sign || !keyId || !expectedAddress || !region) throw new Error('AWS KMS signer requires DescribeKey/GetPublicKey/Sign client methods, key id, expected address and explicit region.'); this.kms = kms; this.keyId = keyId; this.expectedAddress = ethers.getAddress(expectedAddress); this.region = region; this.expectedKeyArn = expectedKeyArn; }
  async identity() { return inspectKmsPublicKey({ kms: this.kms, keyId: this.keyId, region: this.region, expectedAddress: this.expectedAddress, expectedKeyArn: this.expectedKeyArn }); }
  async signDigest(digest) { await this.identity(); const value = ethers.getBytes(digest); if (value.length !== 32) throw new Error('Ethereum signing requires a 32-byte digest.'); const response = await this.kms.sign({ KeyId: this.keyId, Message: value, MessageType: 'DIGEST', SigningAlgorithm: KMS_SIGNING_ALGORITHM }); return recoverKmsSignature(digest, response.Signature || response.signature, this.expectedAddress); }
  async signTransaction(transaction) { const tx = ethers.Transaction.from(transaction); const digest = ethers.keccak256(tx.unsignedSerialized); const signature = await this.signDigest(digest); const signed = tx.clone(); signed.signature = signature; const recovered = ethers.recoverAddress(digest, signature); if (recovered !== this.expectedAddress) throw new Error('Signed transaction failed local signer verification.'); return { signedTransaction: signed.serialized, transactionHash: signed.hash, signer: recovered }; }
}
module.exports = { AwsKmsEthereumSigner, createAwsKmsClient, inspectKmsPublicKey, assertKmsKeyMetadata, KMS_KEY_SPEC, KMS_KEY_USAGE, KMS_SIGNING_ALGORITHM };
