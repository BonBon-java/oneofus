'use strict';
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const { createDatabase, migrate } = require('./db.js'); const { PostgresRepository } = require('./postgres-repository.js'); const { PaymentService } = require('./payment-service.js'); const { ArbitrumPaymentMonitor } = require('./payment-monitor.js'); const { normalizeAddress } = require('./payment-domain.js'); const { seedDemoDraws } = require('./seed-demo-draws.js');
const { RoundLifecycleOrchestrator, RoundLifecycleScheduler } = require('./round-lifecycle-orchestrator.js');
const { validateRuntimeConfiguration } = require('./runtime-config.js');
const { ReportingService } = require('./reporting-service.js');
const root = __dirname;
const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
const publicFiles = new Set(['index.html', 'styles.css', 'script.js', 'countdown.js', 'payment-sources.js', 'payment-session.js', 'payment-modal.js', 'favicon.svg']);
const securityHeaders = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com" };
function send(response, status, body) { response.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
function readJson(request, limit = 10_000) { return new Promise((resolve, reject) => { let size = 0; const chunks = []; let done = false; const fail = (error) => { if (!done) { done = true; reject(error); } }; request.on('data', (chunk) => { size += chunk.length; if (size > limit) { request.destroy(); fail(new Error('Request too large.')); return; } chunks.push(chunk); }); request.on('error', fail); request.on('end', () => { if (done) return; try { done = true; resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { fail(new Error('Invalid JSON.')); } }); }); }
function serveStatic(urlPath, response) { let decoded; try { decoded = decodeURIComponent(urlPath); } catch { return false; } const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, ''); if (!publicFiles.has(relativePath) && !relativePath.startsWith('assets/')) return false; const file = path.resolve(root, relativePath); if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false; response.writeHead(200, { ...securityHeaders, 'content-type': contentTypes[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(response); return true; }
function requestLimiter({ limit = 12, windowMs = 60_000, maxKeys = 10_000 } = {}) { const requests = new Map(); return (request) => { const now = Date.now(); const key = request.socket.remoteAddress || 'unknown'; const record = requests.get(key); if (!record || record.resetAt <= now) { if (!record && requests.size >= maxKeys) { for (const [candidate, value] of requests) if (value.resetAt <= now) requests.delete(candidate); if (requests.size >= maxKeys) return false; } requests.set(key, { count: 1, resetAt: now + windowMs }); return true; } record.count += 1; return record.count <= limit; }; }
function paymentConfigScript({ network = 'Arbitrum One', staging = false } = {}) { return `(function exposePaymentConfig(root, factory) { const config = factory(); if (typeof module === 'object' && module.exports) { module.exports = config; } else { root.ONEOFUS_PAYMENT_CONFIG = config; } })(typeof globalThis !== 'undefined' ? globalThis : this, () => (${JSON.stringify({ mode: 'api', network, staging, sessionEndpoint: '/api/orders', statusEndpoint: '/api/orders/' })}));`; }
function reportingAuthorized(request, token) { return Boolean(token) && request.headers.authorization === `Bearer ${token}`; }
function createServer({ repository, service, health = null, paymentConfig = null, reportingService = null, reportingToken = null }) {
  const allowOrderRequest = requestLimiter();
  return http.createServer(async (request, response) => { try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/healthz') return send(response, 200, { status: 'ok' });
    if (request.method === 'GET' && url.pathname === '/readyz') { const readiness = health ? await health() : { ready: true }; return send(response, readiness.ready ? 200 : 503, readiness); }
    if (request.method === 'GET' && url.pathname === '/payment-config.js') { response.writeHead(200, { ...securityHeaders, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); return response.end(paymentConfigScript(paymentConfig || {})); }
    if (request.method === 'POST' && url.pathname === '/api/orders') { if (!allowOrderRequest(request)) return send(response, 429, { error: 'Too many order requests. Please try again shortly.' }); return send(response, 201, service.publicOrder(await service.create(await readJson(request)))); }
    if (request.method === 'GET' && url.pathname === '/api/site') return send(response, 200, await repository.siteSummary());
    if (request.method === 'GET' && url.pathname === '/api/draws') return send(response, 200, { draws: await repository.draws() });
    if (url.pathname.startsWith('/reporting/')) {
      if (!reportingAuthorized(request, reportingToken)) return send(response, 401, { error: 'Reporting authentication required.' });
      if (!reportingService) return send(response, 503, { error: 'Reporting is unavailable.' });
      if (request.method === 'GET' && url.pathname === '/reporting/overview') return send(response, 200, await reportingService.overview());
      if (request.method === 'GET' && url.pathname === '/reporting/settlements') return send(response, 200, { settlements: await reportingService.settlements() });
      return send(response, 404, { error: 'Reporting route not found.' });
    }
    const verifyMatch = url.pathname.match(/^\/api\/draws\/([0-9a-f-]{36})\/verify$/i); if (request.method === 'GET' && verifyMatch) { const verification = await repository.verifyDraw(verifyMatch[1]); return verification ? send(response, 200, verification) : send(response, 404, { error: 'Draw not found.' }); }
    const participantMatch = url.pathname.match(/^\/api\/participants\/([0-9a-f-]{36})\/entries$/i); if (request.method === 'GET' && participantMatch) { const entry = await repository.participantEntries(participantMatch[1]); return entry ? send(response, 200, entry) : send(response, 404, { error: 'Participant not found.' }); }
    const orderMatch = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})$/i); if (request.method === 'GET' && orderMatch) { await service.expirePending(); const order = await repository.getOrder(orderMatch[1]); return order ? send(response, 200, service.publicOrder(order)) : send(response, 404, { error: 'Order not found.' }); }
    if (request.method === 'GET' && serveStatic(url.pathname, response)) return; send(response, 404, { error: 'Not found.' });
  } catch { send(response, 400, { error: 'Invalid request.' }); } });
}
async function main() {
  const target = validateRuntimeConfiguration();
  const receivingAddress = normalizeAddress(process.env.ONE_OF_US_RECEIVING_ADDRESS);
  const pool = createDatabase(); await migrate(pool); await seedDemoDraws(pool); const repository = new PostgresRepository(pool); const service = new PaymentService(repository, receivingAddress);
  let monitor; let scheduler;
  const reportingService = process.env.REPORTING_AUTH_TOKEN ? new ReportingService(repository, { gasBalanceWei: '0', warningGasWei: process.env.GAS_WARNING_WEI || '0', criticalGasWei: process.env.GAS_CRITICAL_WEI || '0' }) : null;
  const server = createServer({ repository, service, reportingService, reportingToken: process.env.REPORTING_AUTH_TOKEN || null, paymentConfig: { network: target.network, staging: target.chainId === 421614 }, health: async () => {
    const rpc = monitor?.status() || null;
    try { await pool.query('SELECT 1'); } catch { return { ready: false, database: 'unavailable', rpc }; }
    return { ready: Boolean(rpc?.ready), database: 'ready', rpc, payout: { ready: Boolean(target.payoutSigner?.enabled), mode: target.payoutSigner?.mode || 'disabled', reason: target.payoutSigner?.enabled ? null : 'payouts_fail_closed' } };
  } });
  server.listen(Number(process.env.PORT || 4174), () => console.log(`One of Us payment API listening on ${process.env.PORT || 4174}`));
  monitor = new ArbitrumPaymentMonitor({ repository, service, rpcUrls: target.rpcUrls, receivingAddress, target }); monitor.start();
  if (process.env.ONE_OF_US_SCHEDULER_ENABLED === 'true') { scheduler = new RoundLifecycleScheduler(new RoundLifecycleOrchestrator({ repository })); scheduler.start(); }
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true; monitor.stop(); scheduler?.stop(); await new Promise((resolve) => server.close(resolve)); await pool.end(); };
  process.once('SIGTERM', () => shutdown().catch((error) => { console.error(error.message); process.exitCode = 1; }));
  process.once('SIGINT', () => shutdown().catch((error) => { console.error(error.message); process.exitCode = 1; }));
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { createServer, paymentConfigScript, reportingAuthorized };
