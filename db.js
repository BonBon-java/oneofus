'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

function createDatabase() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured before starting the payment API.');
  return new Pool({ connectionString: process.env.DATABASE_URL });
}
async function migrate(pool) {
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('oneofus-schema-migrations'))");
    await lock.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const name of fs.readdirSync(path.join(__dirname, 'migrations')).filter((file) => file.endsWith('.sql')).sort()) {
      const applied = await lock.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (applied.rowCount) continue;
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query(fs.readFileSync(path.join(__dirname, 'migrations', name), 'utf8')); await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]); await client.query('COMMIT'); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
  } finally { try { await lock.query("SELECT pg_advisory_unlock(hashtext('oneofus-schema-migrations'))"); } finally { lock.release(); } }
}
module.exports = { createDatabase, migrate };
