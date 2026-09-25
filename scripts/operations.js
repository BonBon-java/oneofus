'use strict';
const { createDatabase, migrate } = require('../db.js');
const { PostgresRepository } = require('../postgres-repository.js');

async function main() {
  const [action, control] = process.argv.slice(2); const actor = process.env.ONE_OF_US_OPERATOR_ID;
  const pool = createDatabase();
  try {
    await migrate(pool); const repository = new PostgresRepository(pool);
    if (action === 'status') { console.log(JSON.stringify(await repository.operationalControls(), null, 2)); return; }
    if (!['pause', 'resume'].includes(action) || !control) throw new Error('Usage: operations.js status | pause <control> | resume <control>');
    if (!actor) throw new Error('ONE_OF_US_OPERATOR_ID is required for a control change.');
    await repository.setOperationalControl(control, action === 'resume', actor);
    console.log(`${control} ${action}d by ${actor}`);
  } finally { await pool.end(); }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
