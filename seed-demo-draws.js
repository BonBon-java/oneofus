'use strict';
const crypto = require('node:crypto');
async function seedDemoDraws(pool) {
  if (process.env.NODE_ENV === 'production') return;
  const exists = await pool.query('SELECT 1 FROM draw_history WHERE is_demo LIMIT 1'); if (exists.rowCount) return;
  for (const [index, name] of ['Mira', 'Jon', 'Sasha', 'Avery', 'Noa', 'Rin', 'Kai', 'Tess', 'Lena', 'Omar'].entries()) {
    const date = new Date(Date.now() - (index + 1) * 86_400_000); const amount = String((120 + index * 37) * 1_000_000);
    await pool.query(`INSERT INTO draw_history (id, draw_date, status, total_paid_tickets, pool_amount, prize_amount, winner_name, winner_payout_wallet, winning_ticket_number, is_demo, created_at, updated_at) VALUES ($1,$2,'completed',$3,$4,$4,$5,$6,$7,true,$2,$2)`, [crypto.randomUUID(), date, 120 + index * 37, amount, name, `0x${String(index + 1).padStart(40, '0')}`, 42 + index * 13]);
  }
}
module.exports = { seedDemoDraws };
