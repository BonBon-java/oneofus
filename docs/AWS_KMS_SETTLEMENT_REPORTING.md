# AWS KMS, settlement and reporting

## Production boundary

The backend creates immutable settlement records; it never receives an AWS credential or a private key. The isolated signer service is private-network only and accepts authenticated, idempotent settlement-leg identifiers. It may construct only an Arbitrum ERC-20 `transfer` for the configured USDT, recipient and amount stored in that immutable leg. It cannot spend from the cold treasury.

Production remains fail-closed until all required configuration is supplied: an expected signer address, treasury address, signer URL/authentication, AWS KMS key ID/region, single-payout limit and gas reserve. Raw key environment variables are rejected.

## AWS setup

The supported KMS configuration is an asymmetric, customer-managed test key with `KeySpec=ECC_SECG_P256K1`, `KeyUsage=SIGN_VERIFY` and signing algorithm `ECDSA_SHA_256`. Those are the current AWS KMS values for secp256k1 signing. The smoke signer explicitly calls `DescribeKey`, rejects a disabled or incompatible key, requires the key ARN's region to equal `AWS_REGION`, then verifies that `GetPublicKey` reports the same compatible values before parsing its DER SPKI key.

Choose a non-production region explicitly (for example `eu-central-1`), and create a clearly labelled test key. Do not put secrets, account data or production identifiers in the description, alias or tags.

```sh
aws kms create-key --region eu-central-1 --key-usage SIGN_VERIFY --key-spec ECC_SECG_P256K1 --description "One of Us KMS smoke test only"
aws kms create-alias --region eu-central-1 --alias-name alias/oneofus-kms-smoke-test --target-key-id KEY_ID
```

The runtime signer identity needs only the following actions on the exact test-key ARN; it does not need administration, deletion, encryption or broad `kms:*` access:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["kms:DescribeKey", "kms:GetPublicKey", "kms:Sign"],
    "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY_ID"
  }]
}
```

Provisioning a key or alias can require additional, temporary administrative permissions. Keep that separate from this runtime policy. Verify the final key policy also permits the intended workload identity for these three actions.

Use workload identity or mTLS between backend and signer; a scoped rotating bearer token is transitional staging-only. Never expose the signer service to the public Internet or reuse reporting credentials.

The implementation parses KMS SPKI public keys, derives the Ethereum address, decodes DER ECDSA signatures, normalizes low-s, recovers the signer and verifies it locally before a transaction can be broadcast. Local tests use an equivalent secp256k1 fixture. No AWS account was called by those tests.

With an approved non-production KMS key and normal AWS workload/profile credentials, first derive the address and record the returned key ARN without committing either configuration value:

```sh
AWS_REGION=eu-central-1 AWS_KMS_KEY_ID=alias/oneofus-kms-smoke-test npm run payout:kms-address
```

Then pass that address and ARN explicitly to the smoke test:

```sh
AWS_REGION=eu-central-1 \
AWS_KMS_KEY_ID=alias/oneofus-kms-smoke-test \
AWS_KMS_EXPECTED_KEY_ARN=arn:aws:kms:REGION:ACCOUNT:key/KEY_ID \
PAYOUT_EXPECTED_SIGNER_ADDRESS=0xDERIVED_ADDRESS \
npm run payout:kms-smoke
```

The test signs the fixed Keccak-256 digest of `oneofus-kms-smoke-v1:no-economic-authority`; it contains no settlement, account, recipient, amount or serialized transaction. It only performs `DescribeKey`, `GetPublicKey` and `Sign`, parses the DER ECDSA result, normalizes low-s, searches recovery parity, and requires the recovered address to equal `PAYOUT_EXPECTED_SIGNER_ADDRESS`. It never creates, signs or broadcasts a blockchain transaction. A deliberately wrong `PAYOUT_EXPECTED_SIGNER_ADDRESS` must fail before signing.

To retire an unused smoke key, schedule deletion using the account's approved retention window; do not delete a key immediately. Keep production payouts disabled regardless of smoke-test success until a separate production authorization occurs.

## Economics and operations

For each settlement, winner amount is `floor(gross * 85 / 100)` and project gross fee is the remainder. Gas is stored in wei separately: it never reduces the winner transfer and is not converted or subtracted from USDT without an explicit price source. Treasury sweep is a separate immutable leg, sourced from settlement accounting, never `balanceOf(wallet)`.

The KMS signer address is the gas wallet. The operator manually replenishes ETH after a low-gas warning. The system does not swap USDT, buy ETH, bridge, transfer from treasury, or refill gas automatically.

## Reporting

`/reporting/overview` and `/reporting/settlements` are authenticated GET-only endpoints. They expose accounting and gas status, not signing or mutation controls. Configure a distinct reporting token and, in deployment, a SELECT-only database role for reporting queries. A reporting credential must never be accepted by the signer service.
