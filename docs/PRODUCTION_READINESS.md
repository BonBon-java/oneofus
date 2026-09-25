# Production readiness

`ONE_OF_US_ENV` is explicit: `local` uses the local MockUSDT chain, `staging`
uses Arbitrum Sepolia and a dedicated six-decimal test token, and `production`
uses the pinned Arbitrum One USDT target. Startup rejects a mode/chain mismatch,
plaintext non-local RPC URLs, and malformed bounded operational settings.

Use two independently operated HTTPS RPC endpoints. The monitor retries a
request across endpoints with a bounded timeout, scans in persisted chunks, and
rescans a short history on every run. A cursor is written only after the whole
chunk has been recorded, so a failure cannot skip events. Payment finalization
still validates each stored block hash against the canonical block.

The project intentionally has no production payout signer. `ONE_OF_US_PAYOUT_MODE`
is test-only and is rejected with `NODE_ENV=production`; no environment private
key can unlock a mainnet transfer. Mainnet payouts require a separately reviewed
external/KMS signer, explicit per-transfer approval, treasury reconciliation,
and a new release review.

## Staging gate

1. Copy `.env.staging.example` outside the repository and replace placeholders.
2. Deploy a dedicated test ERC-20, fund only the staging receiving wallet with
   test assets, and record token address, transaction hashes, and operator.
3. Run migrations, start the API, then verify `/healthz` and `/readyz`.
4. Create an order, make one test transfer, wait 12 confirmations, and verify
   the order, ticket range, and draw snapshot in PostgreSQL.
5. Stop/restart the API during scanning; confirm the cursor resumes without a
   duplicate ticket range. Exercise primary-RPC failure while fallback succeeds.
6. Keep payout disabled. A successful staging inbound flow is not authorization
   to send production funds.

## Deployment and recovery

Run `npm run db:migrate` as a release step. Migrations take a PostgreSQL advisory
lock, preventing concurrent deploys from applying different schemas. Deploy at
least two API instances behind a TLS reverse proxy; use shared edge rate limits
and managed PostgreSQL with TLS, backups, point-in-time recovery, and a tested
restore procedure. The application itself does not create databases or backups.

Before each release, take and verify an encrypted `pg_dump`, restore it to an
isolated database, run read-only reconciliation queries, and keep the backup
retention/access policy with the infrastructure owner. Never put RPC credentials,
wallet keys, or database passwords in `.env.*` committed files, CI logs, or issue
comments.
