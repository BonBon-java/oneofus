# Payout architecture

## Current safe mode

Automated transfers are enabled only when `PAYOUT_MODE=test` and all of these
server-side values are present:

```text
POOL_WALLET_ADDRESS
TREASURY_WALLET_ADDRESS
ONE_OF_US_PAYOUT_CHAIN_ID
ONE_OF_US_PAYOUT_TOKEN_ADDRESS
```

`POOL_WALLET_ADDRESS` is the address that owns the temporary pool key.  In the
local test it is a disposable Hardhat account.  No real MetaMask key, seed
phrase, AWS production key, Arbitrum One USDT transfer, swap, bridge or ETH
purchase is configured by this repository.

## Money flow

The authoritative frozen draw snapshot supplies `grossPool`, never a browser
or an API request.  Amounts are integer USDT base units:

```text
winner   = floor(grossPool * 85 / 100)
treasury = grossPool - winner
```

The service persists exactly two immutable ERC-20 transfer legs before it
asks a signer for anything:

```text
pool wallet ── 85% USDT ──> winner address from the locked ticket ledger
pool wallet ── 15% USDT ──> treasury address from server configuration
```

ETH stays in the pool wallet only as a manually replenished Arbitrum gas
reserve.  It is not taken from the winner’s USDT.  The treasury still receives
the full 15% USDT; ETH gas is a separate project expense.

## Durable lifecycle and recovery

```text
pending → preparing → winner_submitted → winner_confirmed
        → treasury_submitted → settled
```

Before the winner transaction, the provider verifies the chain ID, token
bytecode/decimals, configured pool signer, full USDT total for both legs, and
ETH sufficient for both estimated transactions plus margin.  Low USDT or ETH
blocks the settlement without attempting a transfer.

Every leg stores recipient, amount, chain, token, sender, nonce, signed hash,
confirmation timestamp, gas used, effective gas price and actual ETH gas cost.
If the winner is confirmed, retries select only the treasury leg.  A broadcast
whose result is ambiguous becomes `broadcast_unknown` and is never blindly
signed again.  Database row locks and the unique `(settlement_id, kind)` legs
prevent duplicate transfers across HTTP retries and worker restarts.

## Signing boundary

The payout provider accepts only a configured USDT `transfer(recipient, amount)`
from an immutable leg.  It has no arbitrary transaction or arbitrary token
endpoint.  The present local/test implementation uses a server-only disposable
key.  The existing AWS KMS secp256k1 adapter implements the same signer shape
for Arbitrum Sepolia test use; replacing the test signer with a future KMS
signer for the same production pool address does not change settlement logic.

Production remains intentionally disabled.  Before enabling it separately,
review the signer custody/migration procedure, configure the real Arbitrum One
USDT contract and pool/treasury addresses, fund the pool with a small manual
ETH reserve, validate on a controlled test transaction, and obtain explicit
operator approval.  Do not put a MetaMask secret in source control or chat.

## Reporting

Authenticated read-only reporting exposes the two transaction hashes/statuses,
gross pool, winner and treasury amounts, individual and total gas in wei, and
the current pool USDT/ETH balances when the test payout provider is available.
It does not convert ETH gas to a made-up USD/USDT value, and therefore reports
project net revenue as unavailable until a separately approved reliable price
source exists.
