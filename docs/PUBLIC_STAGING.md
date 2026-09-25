# Public Arbitrum Sepolia staging

This repository is prepared for a public **Arbitrum Sepolia** staging deployment.
It is not a production deployment and must use only `OneOfUs Staging USDT`
(`sUSDT`), a six-decimal token deployed specifically for this environment.

## Topology and boundaries

```
staging UI -> HTTPS staging API -> managed PostgreSQL (staging only)
                              -> primary + fallback Arbitrum Sepolia RPC
                              -> sUSDT contract + disposable staging signer
```

The API serves the static UI too, so a single container is the least-complex
deployment option until a separate static host is selected. Run it behind a TLS
reverse proxy or managed web-service endpoint. There is intentionally no cloud
provider configuration in the repository: no hosting account or database
credential is available here. Do not point a staging variable at production.
When served by the staging API, the payment dialog identifies **Arbitrum
Sepolia · TESTNET** and warns that only staging `sUSDT` belongs there.

Network parameters are verified against the [Arbitrum network reference](https://docs.arbitrum.io/arbitrum-bridge/quickstart): chain ID `421614`, official
public RPC `https://sepolia-rollup.arbitrum.io/rpc`, and explorer
`https://sepolia.arbiscan.io`. Use an independent provider as fallback; the
official public endpoint is useful for validation but is not a reliability SLA.

## Deploy from scratch

1. Create a managed PostgreSQL database named `oneofus_staging`, enforce TLS,
   backups and point-in-time recovery. Save its URL only in the host secret
   store.
2. Copy `.env.staging.example` to an untracked secret store and set unique
   staging database, receiving address, two HTTPS RPC URLs and frontend/API URLs.
3. Fund a disposable deployer with Arbitrum Sepolia ETH. Deploy the test token:

   ```sh
   ARBITRUM_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
   STAGING_DEPLOYER_PRIVATE_KEY=0x... \
   ONE_OF_US_DEPLOYMENT_FILE=deployments/arbitrum-sepolia.json \
   node scripts/deploy-staging-usdt.js
   ```

   The script refuses every chain except `421614` (or explicit local test mode),
   verifies bytecode/name/symbol/decimals, and writes no private key to metadata.
4. Set `ONE_OF_US_PAYMENT_TOKEN_ADDRESS` to the printed token address. Keep
   payouts disabled for inbound-payment validation. If a staging payout is later
   approved, `ONE_OF_US_PAYOUT_*` must name exactly the same chain and token; its
   private key is disposable and only lives in the host secret store.
5. Build and release with `docker build -t oneofus-staging .`, then run
   `npm run db:migrate` as the release step with the staging `DATABASE_URL`.
   Start `node server.js` with the same secrets and a public `PORT`.
6. Verify the public service and network before accepting a payment:

   ```sh
   STAGING_API_URL=https://api.staging.example \
   ARBITRUM_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
   ARBITRUM_RPC_FALLBACK_URL=https://independent-provider.example/rpc \
   ONE_OF_US_PAYMENT_TOKEN_ADDRESS=0x... \
   node scripts/staging-smoke.js
   ```

   The smoke check calls `eth_chainId`, head block/timestamp, `eth_getLogs`,
   `eth_getCode`, and optionally `eth_getTransactionReceipt`; it also requires
   both public health endpoints to pass. GitHub's manual **Staging smoke**
   workflow takes public API/token inputs and reads RPC URLs from environment
   secrets `STAGING_RPC_URL` and `STAGING_RPC_FALLBACK_URL`.

## Public-chain validation procedure

Create a real order, transfer the exact order amount in `sUSDT` to the staging
receiving wallet, then record only the order ID, amount, transaction hash and
block number in the operations log. Confirm the order moves from awaiting
payment to confirming and finalizes only after `PAYMENT_CONFIRMATIONS`; inspect
the one payment row and one non-overlapping ticket-ledger range in PostgreSQL.
Run `node scripts/staging-smoke.js` with `STAGING_TRANSACTION_HASH` to make the
test resumable.

For restart safety, restart the backend while the transfer is confirming, then
force a bounded historical rescan by restarting again. The scanner stores the
cursor only after every complete chunk and database event uniqueness makes
overlap idempotent. To exercise failover, temporarily make the primary staging
RPC invalid in a single API instance; the fallback must complete the same read
without producing another payment effect. Never disable both production
endpoints for this test.

`/healthz` is process liveness. `/readyz` requires a live PostgreSQL query and
a fresh successful monitor scan; its redacted RPC status includes cursor/head
timing, endpoint count, active error, and scan age, but never URLs or secrets.
The production readiness endpoint must remain red on a DB outage, wrong chain,
wrong token metadata, or stale/unavailable RPC.

## Operations and reconciliation

Use `npm run operations -- status` to inspect controls. For an audited change,
set the staging-only `ONE_OF_US_OPERATOR_ID` and run `pause` or `resume` for
`orders`, `payment_finalization`, `draws`, or `payouts`. Restore controls after
each exercise. Do not seed payment rows or simulated balances in public staging.

Reconcile a bounded block range by comparing Transfer logs for the configured
token/receiving address to `payments`, `ticket_ledger`, scanner cursor, and
finalized orders. Record any late payment separately; never reuse its payment
code. Separate ERC-20 accounting from Sepolia ETH gas costs.

Run short finite soak observations after a deployment: invoke the smoke script
at least three times across backend restarts and record health status, head,
scanner lag, pending payments and fallback behavior. A manual workflow is
deliberately optional so protected pull-request checks never depend on public
RPC availability.

## Secret classification

Public: chain ID, explorer URL, token address, receiving address, confirmation
count. Sensitive: non-secret internal deployment endpoints. Secret: database
URL/password, provider URLs containing keys, `STAGING_DEPLOYER_PRIVATE_KEY`,
`ONE_OF_US_PAYOUT_PRIVATE_KEY`, and operator credentials. Never put any of the
last group in Git, Pages, logs, PR descriptions, or deployment metadata.

## Before real USDT

Production remains disabled. Before any real-money operation, obtain a reviewed
external/KMS or MPC signing path with per-transfer approval, a separately
verified Arbitrum One USDT address from an authoritative source, independently
operated production RPCs, production database/backup recovery evidence, and a
security review. A successful `sUSDT` staging payout is not authorization for a
mainnet payout.
