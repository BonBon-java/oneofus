# Operations runbook

## Normal checks

Use `GET /healthz` for process liveness and `GET /readyz` for database/RPC
readiness. Readiness remains false until the payment monitor has completed a
successful RPC request. Alert on a non-200 readiness response, scanner cursor
age, RPC failover errors, payment-detected orders older than the confirmation
window, or lifecycle retries.

## Incident response

1. Stop the scheduler before investigating a draw or payout anomaly.
2. Preserve database and application logs; do not edit payment, ticket, draw,
   or payout rows manually.
3. Compare detected payment block hashes with an independent Arbitrum RPC.
4. Restart the monitor only after the endpoint and canonical chain are healthy;
   its bounded historical rescan is idempotent.
5. Keep all payouts disabled. Escalate any payout request to the approved
   external-signer procedure; this repository contains no production executor.

For a graceful deploy, send `SIGTERM`: the API stops monitor/scheduler timers,
closes HTTP intake, then closes PostgreSQL connections. Roll back application
code only after confirming schema compatibility; never roll back migrations by
deleting data. Record incident time, operator, affected round/order IDs, RPC
endpoints, and resolution in the operations system.

## Emergency controls

The database stores separately auditable controls for `orders`,
`payment_finalization`, `draws`, and `payouts`. The public API has no route to
change them. A host operator may inspect controls with `npm run operations --
status`, or make an auditable change with `ONE_OF_US_OPERATOR_ID=<operator> npm
run operations -- pause orders` (replace `pause` with `resume` only after review).
Production payout execution remains unavailable; pause `payouts` before any
incident investigation or maintenance window.
