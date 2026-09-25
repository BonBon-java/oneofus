'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const crypto = require('node:crypto'); const { ethers } = require('ethers');
const { ethereumAddressFromSpki, derEcdsaSignature, recoverKmsSignature } = require('../kms-ethereum.js'); const { AwsKmsEthereumSigner } = require('../aws-kms-signer.js');
function derInteger(hex) { const raw = Buffer.from(hex.replace(/^0x/, ''), 'hex'); const value = raw[0] & 0x80 ? Buffer.concat([Buffer.from([0]), raw]) : raw; return Buffer.concat([Buffer.from([2, value.length]), value]); }
function derSignature(signature) { const body = Buffer.concat([derInteger(signature.r), derInteger(signature.s)]); return Buffer.concat([Buffer.from([0x30, body.length]), body]); }
function fixture() { const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }); const spki = pair.publicKey.export({ format: 'der', type: 'spki' }); const address = ethereumAddressFromSpki(spki); const key = new ethers.SigningKey(`0x${Buffer.from(pair.privateKey.export({ format: 'jwk' }).d, 'base64url').toString('hex')}`); return { spki, address, key }; }
test('DER/SPKI public key derives its Ethereum address and KMS DER signature recovers it', async () => {
  const f = fixture(); const digest = ethers.keccak256(ethers.toUtf8Bytes('oneofus-kms-fixture')); const der = derSignature(f.key.sign(digest)); const parsed = derEcdsaSignature(der); assert.ok(parsed.r > 0n); assert.equal(ethers.recoverAddress(digest, recoverKmsSignature(digest, der, f.address)), f.address);
});
test('AWS KMS adapter verifies identity and signs an Ethereum transaction before returning it', async () => {
  const f = fixture(); const kms = { getPublicKey: async () => ({ PublicKey: f.spki }), sign: async ({ Message }) => ({ Signature: derSignature(f.key.sign(ethers.hexlify(Message))) }) }; const signer = new AwsKmsEthereumSigner({ kms, keyId: 'alias/test', expectedAddress: f.address, region: 'eu-central-1' });
  const tx = await signer.signTransaction({ chainId: 42161, nonce: 0, to: '0x1111111111111111111111111111111111111111', value: 0, data: '0x', gasLimit: 21000, maxFeePerGas: 1, maxPriorityFeePerGas: 1, type: 2 });
  assert.equal(ethers.Transaction.from(tx.signedTransaction).from, f.address); assert.equal(tx.signer, f.address);
});
