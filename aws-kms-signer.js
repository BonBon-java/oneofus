'use strict';
const { ethers } = require('ethers');
const { ethereumAddressFromSpki, recoverKmsSignature } = require('./kms-ethereum.js');

// The client is injected so this module is testable without AWS credentials. In
// deployment it is an AWS SDK v3 KMS client with GetPublicKeyCommand/SignCommand.
class AwsKmsEthereumSigner {
  constructor({ kms, keyId, expectedAddress, region }) { if (!kms?.getPublicKey || !kms?.sign || !keyId || !region) throw new Error('AWS KMS signer requires kms client, key id and explicit region.'); this.kms = kms; this.keyId = keyId; this.expectedAddress = ethers.getAddress(expectedAddress); this.region = region; }
  async identity() { const publicKey = await this.kms.getPublicKey({ KeyId: this.keyId }); const address = ethereumAddressFromSpki(publicKey.PublicKey || publicKey.publicKey); if (address !== this.expectedAddress) throw new Error('KMS derived address does not match configured signer address.'); return { address, provider: 'aws-kms', region: this.region }; }
  async signDigest(digest) { await this.identity(); const value = ethers.getBytes(digest); if (value.length !== 32) throw new Error('Ethereum signing requires a 32-byte digest.'); const response = await this.kms.sign({ KeyId: this.keyId, Message: value, MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }); return recoverKmsSignature(digest, response.Signature || response.signature, this.expectedAddress); }
  async signTransaction(transaction) { const tx = ethers.Transaction.from(transaction); const digest = ethers.keccak256(tx.unsignedSerialized); const signature = await this.signDigest(digest); const signed = tx.clone(); signed.signature = signature; const recovered = ethers.recoverAddress(digest, signature); if (recovered !== this.expectedAddress) throw new Error('Signed transaction failed local signer verification.'); return { signedTransaction: signed.serialized, transactionHash: signed.hash, signer: recovered }; }
}
module.exports = { AwsKmsEthereumSigner };
