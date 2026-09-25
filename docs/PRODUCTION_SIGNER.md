# Production payout signer boundary

## Status

The repository implements the boundary and defaults production payouts to disabled. No cloud KMS, MPC account, production key, or real-money transaction was configured or exercised.

## Trust boundary

The application persists a payout intent from an immutable draw result before any signing. It supplies an isolated signer only the fixed tuple `{intent id, chain ID, token address, recipient, integer amount}`. There is no application-facing arbitrary calldata or generic transaction-signing method. The signer service must independently allow-list Arbitrum One and the canonical token.

Modes are explicit: local/staging use a disposable raw key on approved test chains only; production uses `production-external` or remains disabled. Production rejects `ONE_OF_US_PAYOUT_PRIVATE_KEY`, `PRIVATE_KEY`, and `PAYOUT_PRIVATE_KEY` outright. It never falls back to a raw key.

The provided `HttpIsolatedSignerClient` is deliberately provider-neutral. It is suitable as the narrow API in front of AWS KMS, Google Cloud KMS, Azure Key Vault, or an MPC/custody provider. The upstream service is responsible for secp256k1 signature normalization/recovery, KMS request correlation, and only accepting approved ERC-20 transfer payloads.

## State and recovery

`pending → signed → broadcast → confirmed` is the ordinary path. A timeout after broadcast becomes `broadcast_unknown`, never `retryable`: the worker must reconcile transaction hash and sender nonce first. Evidence of a consumed nonce without a matching transaction becomes `manual_review`; it cannot automatically create another transfer. Row locks plus one `payout_intents` record per unique settlement (and one settlement per round) provide database-level idempotency across workers.

`payouts` is independently pausable through the operations CLI. A paused or over-limit obligation remains durable and is not broadcast.

## Operations

```
npm run operations -- status
npm run operations -- pause payouts
npm run payout:dry-run -- <settlement-uuid>
```

The dry-run resolves the stored intent, checks chain/token/signer, balances, nonce and gas estimate, and prints an unsigned transfer summary. It does not sign or broadcast. `npm run payout:signer-smoke` checks only external signer identity and requires production configuration; it does not sign or broadcast.

## Production KMS/MPC setup checklist

1. Provision an externally held secp256k1 key in the selected KMS/MPC custody system; do not export it.
2. Derive its Ethereum address from the public key and fund that address with controlled treasury and native gas.
3. Deploy an isolated signer service which exposes only the three documented `/v1/payout-signer/*` endpoints and validates chain, token, recipient, and amount from a durable intent ID.
4. Give the API workload identity permission only to invoke that signer service. Give the signer identity only minimal KMS/MPC signing permission for one key. Humans receive read-only audit access, not direct signing permission.
5. Configure `PAYOUT_SIGNER_MODE=production-external`, `PAYOUT_EXPECTED_SIGNER_ADDRESS`, HTTPS `PAYOUT_SIGNER_URL`, and a short-lived `PAYOUT_SIGNER_AUTH_TOKEN`; leave `PAYOUT_ENABLED=false`.
6. Run `npm run payout:signer-smoke`, then a dry-run for a controlled finalized obligation. Correlate the application payout intent ID with the KMS/MPC audit request ID.
7. Set conservative integer limits, rehearse pause/reconciliation, and enable payouts only during a controlled canary.

For suspected compromise: pause payouts, revoke signer workload identity, move treasury funds through the incident process, reconcile all `broadcast_unknown`/pending intents, rotate to a new address during maintenance, update expected signer address, and repeat smoke and dry-run before resuming.
