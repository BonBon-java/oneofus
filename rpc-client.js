'use strict';

class RpcError extends Error {
  constructor(message, { retryable = true } = {}) { super(message); this.name = 'RpcError'; this.retryable = retryable; }
}

class ResilientRpcClient {
  constructor({ urls, fetchFunction = fetch, timeoutMs = 10_000, attempts = 3, logger = console } = {}) {
    this.urls = [...new Set((urls || []).filter(Boolean))];
    if (!this.urls.length) throw new Error('At least one RPC URL is required.');
    this.fetchFunction = fetchFunction; this.timeoutMs = timeoutMs; this.attempts = attempts; this.logger = logger; this.activeUrl = 0; this.lastSuccessAt = null; this.lastError = null;
  }
  async call(method, params) {
    let lastError;
    const tries = Math.max(1, this.attempts);
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const index = (this.activeUrl + attempt) % this.urls.length;
      try {
        const result = await this.request(this.urls[index], method, params);
        this.activeUrl = index; this.lastSuccessAt = new Date(); this.lastError = null;
        return result;
      } catch (error) { lastError = error; this.lastError = error.message; }
    }
    throw new RpcError(`RPC ${method} failed after ${tries} attempts: ${lastError?.message || 'unknown error'}.`);
  }
  async request(url, method, params) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFunction(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: controller.signal });
      const body = await response.json();
      if (!response.ok || body.error) throw new RpcError(body.error?.message || `HTTP ${response.status}`);
      return body.result;
    } catch (error) { throw error instanceof RpcError ? error : new RpcError(error.name === 'AbortError' ? 'request timed out' : error.message); } finally { clearTimeout(timer); }
  }
  status() { return { ready: Boolean(this.lastSuccessAt), lastSuccessAt: this.lastSuccessAt, lastError: this.lastError, endpointCount: this.urls.length }; }
}

module.exports = { ResilientRpcClient, RpcError };
