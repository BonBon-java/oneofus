# AWS KMS, settlement and reporting

## Production boundary

The backend creates immutable settlement records; it never receives an AWS credential or a private key. The isolated signer service is private-network only and accepts authenticated, idempotent settlement-leg identifiers. It may construct only an Arbitrum ERC-20 `transfer` for the configured USDT, recipient and amount stored in that immutable leg. It cannot spend from the cold treasury.

Production remains fail-closed until all required configuration is supplied: an expected signer address, treasury address, signer URL/authentication, AWS KMS key ID/region, single-payout limit and gas reserve. Raw key environment variables are rejected.

## AWS setup

Create an asymmetric KMS key with `ECC_SECG_P256K1` and `SIGN_VERIFY`, in an explicit region. The signer workload needs only `kms:GetPublicKey` and `kms:Sign` on that exact key ARN; do not grant `kms:*`. Example IAM resource placeholder: `arn:aws:kms:REGION:ACCOUNT:key/KEY_ID`.

Use workload identity or mTLS between backend and signer; a scoped rotating bearer token is transitional staging-only. Never expose the signer service to the public Internet or reuse reporting credentials.

The implementation parses KMS SPKI public keys, derives the Ethereum address, decodes DER ECDSA signatures, normalizes low-s, recovers the signer and verifies it locally before a transaction can be broadcast. Local tests use an equivalent secp256k1 fixture. No AWS account was called by those tests.

## Economics and operations

For each settlement, winner amount is `floor(gross * 85 / 100)` and project gross fee is the remainder. Gas is stored in wei separately: it never reduces the winner transfer and is not converted or subtracted from USDT without an explicit price source. Treasury sweep is a separate immutable leg, sourced from settlement accounting, never `balanceOf(wallet)`.

The KMS signer address is the gas wallet. The operator manually replenishes ETH after a low-gas warning. The system does not swap USDT, buy ETH, bridge, transfer from treasury, or refill gas automatically.

## Reporting

`/reporting/overview` and `/reporting/settlements` are authenticated GET-only endpoints. They expose accounting and gas status, not signing or mutation controls. Configure a distinct reporting token and, in deployment, a SELECT-only database role for reporting queries. A reporting credential must never be accepted by the signer service.
