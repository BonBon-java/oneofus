(function exposePaymentConfig(root, factory) {
  const config = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = config;
  } else {
    root.ONEOFUS_PAYMENT_CONFIG = config;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => ({
  mode: 'api',
  network: 'Arbitrum One',
  // The API returns the configured receiving address with each order. Keep it
  // out of this static file so changing it requires a backend deployment.
  sessionEndpoint: '/api/orders',
  statusEndpoint: '/api/orders/',
}));
