'use strict';
const crypto = require('node:crypto');
const { ethers } = require('ethers');
const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

function fromBase64Url(value) { return Buffer.from(value, 'base64url'); }
function ethereumAddressFromSpki(der) {
  const key = crypto.createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' });
  const jwk = key.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'secp256k1') throw new Error('KMS public key is not secp256k1.');
  return ethers.getAddress(ethers.computeAddress(`0x04${fromBase64Url(jwk.x).toString('hex')}${fromBase64Url(jwk.y).toString('hex')}`));
}
function derLength(buffer, offset) { const first = buffer[offset]; if (first < 0x80) return [first, offset + 1]; const bytes = first & 0x7f; if (!bytes || bytes > 4 || offset + 1 + bytes > buffer.length) throw new Error('Invalid DER length.'); let value = 0; for (let i = 0; i < bytes; i += 1) value = value * 256 + buffer[offset + 1 + i]; return [value, offset + 1 + bytes]; }
function derEcdsaSignature(der) {
  const b = Buffer.from(der); let o = 0; if (b[o++] !== 0x30) throw new Error('KMS signature is not a DER sequence.'); const [length, sequence] = derLength(b, o); o = sequence; if (o + length !== b.length) throw new Error('Invalid DER signature length.'); const integer = () => { if (b[o++] !== 0x02) throw new Error('Invalid DER ECDSA integer.'); const [size, start] = derLength(b, o); o = start; const value = b.subarray(o, o + size); o += size; if (!size || (value[0] & 0x80) || (size > 1 && value[0] === 0 && !(value[1] & 0x80))) throw new Error('Non-canonical DER ECDSA integer.'); return BigInt(`0x${value.toString('hex')}`); };
  const r = integer(); const s = integer(); if (o !== b.length || !r || !s || r >= SECP256K1_N || s >= SECP256K1_N) throw new Error('KMS signature is outside secp256k1 range.'); return { r, s };
}
function recoverKmsSignature(digest, der, expectedAddress) {
  const parsed = derEcdsaSignature(der); const s = parsed.s > SECP256K1_N / 2n ? SECP256K1_N - parsed.s : parsed.s;
  for (const yParity of [0, 1]) { const signature = ethers.Signature.from({ r: ethers.toBeHex(parsed.r, 32), s: ethers.toBeHex(s, 32), yParity }); const address = ethers.recoverAddress(digest, signature); if (address === ethers.getAddress(expectedAddress)) return signature.serialized; }
  throw new Error('KMS signature does not recover the configured signer address.');
}
module.exports = { SECP256K1_N, ethereumAddressFromSpki, derEcdsaSignature, recoverKmsSignature };
