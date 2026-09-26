# ONEOFUS

Landing page and a Node payment API backed by portable PostgreSQL.

## Local preview

Install dependencies with `npm install`. No frontend build step is required.

Set the values from `.env.example` in the process environment (for example,
`set -a; source .env; set +a; node server.js` after copying it to `.env`) and
set `ONE_OF_US_RECEIVING_ADDRESS` to the One of Us receiving wallet and set
`DATABASE_URL`. The API is
served on port 4174 by default; host the static files behind the same origin or
proxy `/api` to it. `ARBITRUM_RPC_URL` is required for chain monitoring.

For deployment profiles, copy `.env.staging.example` or
`.env.production.example` into a secret manager rather than Git. The staging
gate, recovery procedure, RPC failover behavior, and explicit mainnet-payout
boundary are documented in [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md)
and [docs/OPERATIONS_RUNBOOK.md](docs/OPERATIONS_RUNBOOK.md).

## Checks

The payment flow creates server-authoritative pending orders and polls their
status. The monitor queries Arbitrum One JSON-RPC for `Transfer` events from
USDT at `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` addressed to
`ONE_OF_US_RECEIVING_ADDRESS`; it never accepts client-supplied transaction data.
Orders, payment events, ticket ranges, payment-code reservations, draw history,
and the scan cursor are persisted in PostgreSQL. GitHub Pages alone cannot run
this API or monitor, so its deployment must be paired with an API host/reverse proxy.

## PostgreSQL

Optionally start a local database with `docker compose up -d postgres`, then run:

```sh
npm run db:migrate
npm run db:import-json
npm start
```

`db:import-json` is an idempotent one-time import from a local legacy backup.
It reads `data/oneofus-payments.json` by default; set `LEGACY_JSON_FILE` to use
another path. Legacy state files are ignored by Git and must not be committed.
Normal application operation no longer reads or writes that JSON file.

To back up PostgreSQL, use `pg_dump "$DATABASE_URL" > oneofus-backup.sql`.
On a VPS, provision any PostgreSQL-compatible server, set `DATABASE_URL`, run
`npm run db:migrate`, import legacy JSON once if needed, and start the app with
`npm start`. No hosting-provider-specific service is required.

Payment-code reservations last 30 minutes by default. The canonical amount and
every supported zero-placement alias are reserved together, and remain
unavailable for another 120 minutes; the values are configurable via environment
variables. The backend uses BigInt USDT units and assigns ticket ranges
atomically within its persisted store only after the configured confirmation
count (default 3). A transaction hash can be credited only once. Late and
duplicate transfers are retained as reconciliation events and never allocate
tickets.

Each new order belongs to a UTC `round`. Confirmed paid tickets are recorded in
the ticket ledger with their payment event and ticket range. The schema enforces
at least 10 paid (not free) tickets before a round may enter `drawing` or
`completed`. `RoundClosingService` locks a round transactionally: an
underfilled round rolls its winner-eligible pool into one linked successor,
while a qualifying round is locked for the snapshot, drand and settlement services.

`DrawSnapshotService` freezes a locked qualifying round into an insert-once
snapshot before it becomes `waiting_for_randomness`. Winner selection reads
the snapshot ranges and frozen pool values, never the live ticket ledger.

## Draw randomness

Entries are locked first. The next public drand random-number round then
determines the winning ticket.

Once all tickets are locked, One of Us automatically uses the first public
drand randomness round that occurs afterward. Because that number does not
exist when entries close, nobody can know the result in advance or buy tickets
after seeing it.

The active source is League of Entropy Quicknet mainnet (chain hash
`52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`). At
snapshot finalization the service permanently commits the first Quicknet round
strictly after that timestamp. The official `drand-client` fetches that exact
round and cryptographically verifies its BLS beacon against the pinned chain
identity. Winner selection reads only the immutable snapshot and uses
`ONE_OF_US_DRAND_V1` rejection sampling; it never calls `latest`, rerolls, or
falls back to server or blockchain randomness.

## Settlement and payout

The current two-leg, test-only pool settlement protocol is documented in
[`docs/PAYOUT_ARCHITECTURE.md`](docs/PAYOUT_ARCHITECTURE.md). Production
Arbitrum One execution remains disabled.

Inbound payment monitoring currently targets **USDT on Arbitrum One** (chain ID
`42161`, token `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9`) via
`ARBITRUM_RPC_URL`. This is mainnet configuration and is **not** used by payout
execution. Payout execution is disabled by default and has no mainnet mode.

The only enabled payout target is explicit `ONE_OF_US_PAYOUT_MODE=testnet` on
an approved local EVM (`31337`) or Arbitrum Sepolia (`421614`), with a separately
configured `ONE_OF_US_PAYOUT_RPC_URL` and `ONE_OF_US_PAYOUT_TOKEN_ADDRESS`.
The token must be a non-production **MockUSDT** contract with exactly 6 decimals.
`ONE_OF_US_PAYOUT_PRIVATE_KEY` is a dedicated test-only signer; it is server-only,
must never be committed or logged, and has no fallback. The provider rejects a
missing signer, disabled mode, unsupported/wrong chain, production USDT address,
missing bytecode, wrong decimals, insufficient test-token balance, and insufficient
native gas before signing or sending.

## Security boundaries

The public API only creates and reads payment sessions and public draw data.
Round closing, snapshot creation, randomness resolution, settlement, payout,
reconciliation, and payment scanning are server-side scheduler/CLI operations;
there are no public administrative HTTP routes. A browser `participantId` is
convenience state only and is never accepted as authorization or used to select
the participant for a new order.

At startup the API validates the receiving wallet, PostgreSQL URL, network
identity, bounded timing/confirmation settings, and mainnet HTTPS RPC URL. It
will not start with testnet payout execution in production. Incoming Transfer
logs are checked against the configured token and receiving wallet, persisted
with their block hash, and checked again against the canonical block before
ticket issuance. Ticket ranges have database-enforced non-overlap constraints.

The backend sends a restrictive CSP, frame denial, `nosniff`, and referrer
policy headers. The public order-creation endpoint has a per-source-IP
in-memory limit of 12 requests per minute; deploy a shared edge rate limit when
running more than one API process.

`tests/fixtures/MockUSDT.sol` is a deliberately minimal, test-only 6-decimal
fixture. Deploy and mint it only on a local EVM or approved testnet. No Solidity
toolchain is bundled with this project.

Settlement applies the product's 15% fee exactly once to the frozen snapshot's
total winner-eligible amount. Existing carried funds have not previously had a
fee deducted in this codebase, so carry-in is included in that one settlement
basis; it is never recalculated from live rounds. Native Arbitrum gas is stored
separately and does not reduce the advertised USDT winner amount. A signed
payout intent is persisted before broadcast; ambiguous failures recover the
same transaction hash/payload rather than creating another transfer.
The draw countdown is calculated from the next `00:00 UTC` on every update.

### Opt-in EVM payout integration

Ordinary tests never access an RPC or send a transaction. To exercise the real
test environment, deploy `MockUSDT`, fund a dedicated test signer with native gas
and MockUSDT, then set the test-only variables in `.env.example` (without adding
the secret to a file) and run:

```sh
RUN_PAYOUT_INTEGRATION_TESTS=true npm run test:payout-integration
```

The test records exact integer balances, sends one `transfer`, simulates a
restart by recovering the persisted signed payload/hash, and verifies the receipt,
network, token, sender, recipient, amount, and `Transfer` event. It logs no key
material. PostgreSQL state-machine integration remains a separate requirement:
use a disposable database and a repository-backed harness before declaring
production readiness.

Operational payout logs are a whitelist of settlement ID, intent ID, transaction
hash, chain ID, token, recipient, amount, and state; signed payloads and secrets
are excluded.

### Fully local payout integration

This is an explicit, disposable integration environment. It uses a single
Hardhat local EVM node (chain ID `31337`) and a dedicated PostgreSQL 16 Docker
Compose service on port `5434`. Hardhat's deterministic development account is
funded with native test gas; the bootstrap compiles the existing
`tests/fixtures/MockUSDT.sol`, deploys it with 6 decimals, and mints test-only
tokens to that signer. No public RPC, real wallet, mainnet chain, or production
USDT address is accepted.

Requirements: Node/npm and Docker with Docker Compose. Install project
dependencies once with `npm install`.

```sh
# Start (or reuse) the isolated PostgreSQL and local EVM stack.
npm run local:integration:start

# Start, migrate, deploy MockUSDT and execute the full test in one command.
npm run test:payout-integration:local

# Run one eligible OPEN round through the real lifecycle orchestrator.
npm run test:orchestrator-e2e:local

# Stop the local EVM and permanently remove only the integration database volume.
npm run local:integration:reset
```

The bootstrap writes `.env.integration.local` with mode `testnet`, local RPC
`http://127.0.0.1:8545`, chain ID `31337`, the freshly deployed MockUSDT
address, database URL, and deterministic test-only key. That file is ignored,
has owner-only permissions, and must never be reused outside this local setup.
The example pattern is committed as `.env.integration.example` without a key.

The run proves, against real PostgreSQL and a real local ERC-20 transfer:
settlement and intent uniqueness, signed-intent persistence, one broadcast from
concurrent workers, confirmation state transition, exact integer token balance
deltas, crash-after-broadcast recovery from the known transaction hash, and
fail-closed token/native-gas preflight behavior. It prints local transaction
hashes only. It does not prove provider behavior, wallet operations, security,
or finality on a public testnet or mainnet.

## Round lifecycle scheduler

The optional scheduler is state-driven and PostgreSQL-backed. Set
`ONE_OF_US_SCHEDULER_ENABLED=true` to start a 15-second sweep (override with
`ONE_OF_US_SCHEDULER_INTERVAL_MS`). It discovers only due/incomplete rounds,
claims each round with a short database lease, and invokes the existing round
closing, snapshot, drand, settlement, payout, and confirmation services. The
persisted transitions are `open → locked → waiting_for_randomness →
winner_selected → settlement_pending → payout_broadcast → completed`; an
underfilled close transitions to `rolled_over` and never enters draw/payout.

`round_lifecycle_runs` records lease ownership, last action/error, retry count,
and next retry time. Temporary RPC/drand failures are retried after the
configured interval; immutable snapshot, drand verification, or payout
integrity errors are retained for operator attention and are not silently
rerolled or rebroadcast.

For a local operator/development retry, use the same coordinator directly:

```sh
npm run round:process -- <round-uuid>
```

It is a server-side CLI, not an unauthenticated HTTP endpoint. Round close time
is read from the persisted UTC `rounds.closes_at` boundary, so the scheduler
does not duplicate midnight or server-local-time calculations.

Run the dependency-free logic tests with:

```sh
node --test tests/*.test.js
```

Browser checks for the Verify Draw modal run locally with Playwright Chromium:

```sh
npm run test:browser
```

### Full local payment audit

Reuse the existing disposable stack and run every Node suite (including
PostgreSQL, local payout/orchestrator and the historical public drand check):

```sh
npm run local:integration:start
node scripts/audit-local.js
node scripts/audit-local.js tests/browser/payment-local.spec.js
```

Each suite gets a fresh `audit_<timestamp>_<index>` PostgreSQL schema. Existing
public data is preserved; schemas are retained for inspection and the script
prints their names. The browser test is opt-in and skipped by ordinary browser
runs. It uses the real API/static server, MockUSDT transfers, monitor scans,
three confirmations, database records, browser polling, reload and API restart.
It also checks duplicate/incorrect/late payments and wallet changes.

Incoming payments default to the existing Arbitrum mainnet configuration. For
an explicitly local API process, set `ONE_OF_US_PAYMENT_MODE=local`,
`ARBITRUM_RPC_URL=http://127.0.0.1:8545`, and
`ONE_OF_US_PAYMENT_TOKEN_ADDRESS` to the deployed MockUSDT. This mode requires
chain 31337, loopback HTTP and a non-production token with six decimals. The
audit injects this target without changing production or environment files.

Orders progress `pending → payment_detected → paid`; ticket issuance and payment
confirmation occur in one database transaction. Unpaid expired orders become
`expired`; a subsequent transfer inside the reconciliation window becomes
`late_payment` without tickets. Extra transfers are recorded as
`duplicate_payment`, and unmatched amounts as `unmatched`. The browser retains
the pending order ID, fetches its authoritative state on reopening after reload,
and restores the existing profile. Active entries and pool totals include
eligible rolled-over tickets while retaining each ticket's original round.

## GitHub Pages

The workflow in `.github/workflows/pages.yml` packages the production HTML,
CSS, JavaScript, favicon, and optimized images, then deploys the artifact to
GitHub Pages after every push to `main`.

All site assets use relative paths, so the landing page works from a project
repository path such as `/oneofus/` and remains compatible with a future
custom domain.

For the first deployment, open the repository's **Settings → Pages** and set
**Source** to **GitHub Actions**.
