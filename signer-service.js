'use strict';
const http = require('node:http');
function json(response, status, value) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); }
// This process deliberately knows no generic transaction endpoint. The executor
// receives a durable settlement-leg id and must load/validate that leg itself.
function createSignerService({ authToken, executor }) {
  if (!authToken || !executor?.identity || !executor?.executeSettlementLeg) throw new Error('Signer service needs internal authentication and a settlement-leg executor.');
  return http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${authToken}`) return json(response, 401, { error: 'Unauthorized.' });
      if (request.method === 'GET' && request.url === '/v1/payout-signer/identity') return json(response, 200, await executor.identity());
      const match = request.url?.match(/^\/v1\/settlement-legs\/([0-9a-f-]{36})\/execute$/i);
      if (request.method === 'POST' && match) return json(response, 200, await executor.executeSettlementLeg(match[1]));
      return json(response, 404, { error: 'Not found.' });
    } catch (error) { return json(response, 503, { error: 'Signer unavailable.' }); }
  });
}
module.exports = { createSignerService };
