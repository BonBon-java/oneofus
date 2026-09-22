(function exposePaymentSources(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.OneOfUsPaymentSources = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // TODO: Verify withdrawal minimums and fee wording with each provider before
  // enabling real payments. Demo values remain at one ticket to avoid presenting
  // unconfirmed exchange limits as permanent rules.
  const paymentSources = Object.freeze([
    Object.freeze({
      id: 'bybit',
      label: 'Bybit',
      enabled: true,
      minimumTickets: 1,
      minimumVerified: false,
      feeText: 'Check the current withdrawal fee in Bybit before sending.',
      instruction: 'Withdraw USDT and select Arbitrum One as the network.',
    }),
    Object.freeze({
      id: 'binance',
      label: 'Binance',
      enabled: true,
      minimumTickets: 1,
      minimumVerified: false,
      feeText: 'Check the current withdrawal fee in Binance before sending.',
      instruction: 'Withdraw USDT and select Arbitrum One as the network.',
    }),
    Object.freeze({
      id: 'okx',
      label: 'OKX',
      enabled: true,
      minimumTickets: 1,
      minimumVerified: false,
      feeText: 'Check the current withdrawal fee in OKX before sending.',
      instruction: 'Withdraw USDT and select Arbitrum One as the network.',
    }),
    Object.freeze({
      id: 'other',
      label: 'Other exchange / wallet',
      enabled: true,
      minimumTickets: 1,
      minimumVerified: false,
      feeText: 'Check the current withdrawal fee and minimum with your provider.',
      instruction: 'Send USDT only through Arbitrum One.',
    }),
  ]);

  function getPaymentSource(sourceId, sources = paymentSources) {
    return sources.find((source) => source.id === sourceId && source.enabled) || null;
  }

  function getMinimumTickets(source) {
    const minimum = Number(source?.minimumTickets);
    return Number.isInteger(minimum) && minimum > 0 ? minimum : 1;
  }

  return {
    getMinimumTickets,
    getPaymentSource,
    paymentSources,
  };
});
