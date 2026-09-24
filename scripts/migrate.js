'use strict';
const { createDatabase, migrate } = require('../db.js');
async function main() { const pool = createDatabase(); try { await migrate(pool); console.log('Database migrations are up to date.'); } finally { await pool.end(); } }
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
