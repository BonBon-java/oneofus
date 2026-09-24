'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresRepository } = require('../postgres-repository.js');

function repositoryWithActivity(activityRows) {
  const queries = [];
  const pool = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (queries.length === 1) return { rows: [{ tickets: '0' }] };
    if (queries.length === 2) return { rows: activityRows };
    return { rowCount: 0, rows: [] };
  } };
  return { repository: new PostgresRepository(pool), queries };
}

test('Live Activity uses confirmed persisted purchases from a 48-hour feed, not only the current round', async () => {
  const { repository, queries } = repositoryWithActivity([{ id: 'order', name: 'Ada', payout_wallet: '0x1111111111111111111111111111111111111111', ticket_quantity: 1, paid_at: '2026-09-23T12:00:00.000Z' }]);
  const summary = await repository.siteSummary();
  assert.deepEqual(summary.activity, [{ id: 'order', name: 'Ada', tickets: 1, paidAt: '2026-09-23T12:00:00.000Z' }]);
  assert.match(queries[1].sql, /payment_status = 'paid'/);
  assert.match(queries[1].sql, /paid_at >= now\(\) - \(\$1 \* interval '1 hour'\)/);
  assert.equal(queries[1].values[0], 48);
  assert.doesNotMatch(queries[1].sql, /round_id/);
});

test('Live Activity returns a deliberate empty collection when no persisted event is inside the window', async () => {
  const { repository } = repositoryWithActivity([]);
  const summary = await repository.siteSummary();
  assert.deepEqual(summary.activity, []);
});
