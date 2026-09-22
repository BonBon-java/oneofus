(function exposePaymentSession(root, factory) {
  const sourcesApi = typeof module === 'object' && module.exports
    ? require('./payment-sources.js')
    : root.OneOfUsPaymentSources;
  const api = factory(sourcesApi);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.OneOfUsPaymentSession = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, ({ getMinimumTickets, getPaymentSource, paymentSources }) => {
  /**
   * @typedef {Object} PaymentSession
   * @property {string} sessionId
   * @property {number} tickets
   * @property {string} baseAmount
   * @property {string} expectedAmount
   * @property {string} paymentSuffix
   * @property {string} source
   * @property {string} network
   * @property {string} recipient
   * @property {string} displayName
   * @property {string} expiresAt
   * @property {boolean} demo
   *
   * Future backend matching must use the received amount, source withdrawal
   * fee behavior, suffix, recipient, transaction hash, chain transaction and
   * session expiry. It must not require receivedAmount === expectedAmount.
   */

  class PaymentSessionError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'PaymentSessionError';
      this.code = code;
    }
  }

  class PaymentDraft {
    constructor({ sources = paymentSources } = {}) {
      this.sources = sources;
      this.displayName = '';
      this.sourceId = sources.find((source) => source.enabled)?.id || '';
      this.tickets = this.minimumTickets;
    }

    get source() {
      return getPaymentSource(this.sourceId, this.sources);
    }

    get minimumTickets() {
      return getMinimumTickets(this.source);
    }

    setDisplayName(value) {
      this.displayName = String(value || '').trim().slice(0, 28);
      return this.displayName;
    }

    setSource(sourceId) {
      const source = getPaymentSource(sourceId, this.sources);
      if (!source) throw new PaymentSessionError('invalid_source', 'Select an available payment source.');
      this.sourceId = source.id;
      this.tickets = Math.max(this.tickets, this.minimumTickets);
      return this.source;
    }

    setTickets(value) {
      const tickets = Number.parseInt(value, 10);
      this.tickets = Math.max(this.minimumTickets, Number.isFinite(tickets) ? tickets : this.minimumTickets);
      return this.tickets;
    }

    increment() {
      return this.setTickets(this.tickets + 1);
    }

    decrement() {
      return this.setTickets(this.tickets - 1);
    }

    toRequest() {
      return {
        displayName: this.displayName || 'Anonymous',
        source: this.sourceId,
        tickets: this.tickets,
        network: 'Arbitrum One',
      };
    }
  }

  function createSessionId(cryptoObject) {
    if (cryptoObject?.randomUUID) return `demo_${cryptoObject.randomUUID()}`;
    return `demo_${Date.now().toString(36)}`;
  }

  class DemoPaymentSessionService {
    constructor(config, { cryptoObject, random = Math.random, now = () => Date.now() } = {}) {
      this.config = config;
      this.crypto = cryptoObject || (typeof crypto !== 'undefined' ? crypto : null);
      this.random = random;
      this.now = now;
    }

    async createPaymentSession(request) {
      const tickets = Math.max(1, Number.parseInt(request.tickets, 10));
      const suffixUnits = Math.max(1, Math.floor(this.random() * 1000));
      const paymentSuffix = `0.${String(suffixUnits).padStart(5, '0')}`;
      const expectedAmount = (tickets + suffixUnits / 100000).toFixed(5);
      const createdAt = this.now();

      return {
        sessionId: createSessionId(this.crypto),
        tickets,
        baseAmount: tickets.toFixed(2),
        expectedAmount,
        paymentSuffix,
        source: request.source,
        network: this.config.network,
        recipient: this.config.demoRecipientAddress,
        displayName: request.displayName || 'Anonymous',
        expiresAt: new Date(createdAt + this.config.sessionDurationMinutes * 60 * 1000).toISOString(),
        demo: true,
      };
    }
  }

  class ApiPaymentSessionService {
    constructor(config, fetchFunction) {
      this.config = config;
      this.fetch = fetchFunction;
    }

    async createPaymentSession(request) {
      if (!this.config.sessionEndpoint || !this.config.recipientAddress) {
        throw new PaymentSessionError('payment_unavailable', 'Payment configuration is not available.');
      }

      const response = await this.fetch(this.config.sessionEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      if (!response.ok) throw new PaymentSessionError('session_failed', 'Could not create a payment session.');
      return response.json();
    }
  }

  function createPaymentSessionService(config, dependencies = {}) {
    if (config.mode === 'demo') return new DemoPaymentSessionService(config, dependencies);
    const fetchFunction = dependencies.fetchFunction || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!fetchFunction) throw new PaymentSessionError('payment_unavailable', 'Payment API is not available.');
    return new ApiPaymentSessionService(config, fetchFunction);
  }

  return {
    ApiPaymentSessionService,
    DemoPaymentSessionService,
    PaymentDraft,
    PaymentSessionError,
    createPaymentSessionService,
  };
});
