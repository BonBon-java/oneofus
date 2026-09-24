'use strict';
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const { createDatabase, migrate } = require('./db.js'); const { PostgresRepository } = require('./postgres-repository.js'); const { PaymentService } = require('./payment-service.js'); const { ArbitrumPaymentMonitor } = require('./payment-monitor.js'); const { normalizeAddress } = require('./payment-domain.js'); const { seedDemoDraws } = require('./seed-demo-draws.js');
const { RoundLifecycleOrchestrator, RoundLifecycleScheduler } = require('./round-lifecycle-orchestrator.js');
const root = __dirname;
const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
const publicFiles = new Set(['index.html', 'styles.css', 'script.js', 'countdown.js', 'payment-config.js', 'payment-sources.js', 'payment-session.js', 'payment-modal.js', 'favicon.svg']);
function send(response, status, body) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
function readJson(request) { return new Promise((resolve, reject) => { let text = ''; request.on('data', (chunk) => { text += chunk; if (text.length > 10_000) reject(new Error('Request too large.')); }); request.on('end', () => { try { resolve(JSON.parse(text || '{}')); } catch { reject(new Error('Invalid JSON.')); } }); }); }
function serveStatic(urlPath, response) { const relativePath = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, ''); if (!publicFiles.has(relativePath) && !relativePath.startsWith('assets/')) return false; const file = path.resolve(root, relativePath); if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false; response.writeHead(200, { 'content-type': contentTypes[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(response); return true; }
function createServer({ repository, service }) {
  return http.createServer(async (request, response) => { try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/api/orders') return send(response, 201, service.publicOrder(await service.create(await readJson(request))));
    if (request.method === 'GET' && url.pathname === '/api/site') return send(response, 200, await repository.siteSummary());
    if (request.method === 'GET' && url.pathname === '/api/draws') return send(response, 200, { draws: await repository.draws() });
    const verifyMatch = url.pathname.match(/^\/api\/draws\/([0-9a-f-]{36})\/verify$/i); if (request.method === 'GET' && verifyMatch) { const verification = await repository.verifyDraw(verifyMatch[1]); return verification ? send(response, 200, verification) : send(response, 404, { error: 'Draw not found.' }); }
    const participantMatch = url.pathname.match(/^\/api\/participants\/([0-9a-f-]{36})\/entries$/i); if (request.method === 'GET' && participantMatch) { const entry = await repository.participantEntries(participantMatch[1]); return entry ? send(response, 200, entry) : send(response, 404, { error: 'Participant not found.' }); }
    const orderMatch = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})$/i); if (request.method === 'GET' && orderMatch) { await service.expirePending(); const order = await repository.getOrder(orderMatch[1]); return order ? send(response, 200, service.publicOrder(order)) : send(response, 404, { error: 'Order not found.' }); }
    if (request.method === 'GET' && serveStatic(url.pathname, response)) return; send(response, 404, { error: 'Not found.' });
  } catch { send(response, 400, { error: 'Invalid request.' }); } });
}
async function main() {
  const receivingAddress = process.env.ONE_OF_US_RECEIVING_ADDRESS ? normalizeAddress(process.env.ONE_OF_US_RECEIVING_ADDRESS) : null;
  if (!receivingAddress) throw new Error('ONE_OF_US_RECEIVING_ADDRESS must be configured before starting the payment API.');
  const pool = createDatabase(); await migrate(pool); await seedDemoDraws(pool); const repository = new PostgresRepository(pool); const service = new PaymentService(repository, receivingAddress);
  const server = createServer({ repository, service });
  server.listen(Number(process.env.PORT || 4174), () => console.log(`One of Us payment API listening on ${process.env.PORT || 4174}`));
  if (process.env.ARBITRUM_RPC_URL) new ArbitrumPaymentMonitor({ repository, service, rpcUrl: process.env.ARBITRUM_RPC_URL, receivingAddress }).start(); else console.warn('ARBITRUM_RPC_URL is not configured; payment monitoring is disabled.');
  if (process.env.ONE_OF_US_SCHEDULER_ENABLED === 'true') new RoundLifecycleScheduler(new RoundLifecycleOrchestrator({ repository })).start();
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { createServer };
