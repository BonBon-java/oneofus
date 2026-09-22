(function exposePaymentConfig(root, factory) {
  const config = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = config;
  } else {
    root.ONEOFUS_PAYMENT_CONFIG = config;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => ({
  mode: 'demo',
  network: 'Arbitrum One',
  recipientAddress: '',
  sessionEndpoint: '',
  // Deliberately invalid and visibly marked. Never replace this with a real
  // recipient unless mode is changed to "api" and the backend issues sessions.
  demoRecipientAddress: '0xDEMO000000000000000000000000000ONEOFUS',
  sessionDurationMinutes: 15,
}));
