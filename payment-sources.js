(function exposePaymentSources(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.OneOfUsPaymentSources = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // USDT / USDT0 withdrawal limits on Arbitrum One. Keep these values together
  // so they can be updated when an exchange changes its withdrawal policy.
  const sendingSources = Object.freeze({
    binance: Object.freeze({ label: 'Binance', minTickets: 3, minimumWithdrawal: '3 USDT', warningText: 'Binance requires a minimum 3 USDT withdrawal on Arbitrum One. Choose at least 3 tickets or use another wallet.' }),
    kucoin: Object.freeze({ label: 'KuCoin', minTickets: 5, minimumWithdrawal: '5 USDT', warningText: 'KuCoin requires a minimum 5 USDT withdrawal on Arbitrum One. Choose at least 5 tickets or use another wallet.' }),
    kraken: Object.freeze({ label: 'Kraken', minTickets: 4, minimumWithdrawal: '4 USDT', warningText: 'Kraken requires a minimum 4 USDT withdrawal on Arbitrum One. Choose at least 4 tickets or use another wallet.' }),
    okx: Object.freeze({ label: 'OKX', minTickets: 2, minimumWithdrawal: '~1.1 USDT', warningText: 'OKX currently has a withdrawal minimum slightly above 1 USDT on Arbitrum One. Choose at least 2 tickets or use another wallet.' }),
    other: Object.freeze({ label: 'Other Wallet', minTickets: 1, minimumWithdrawal: null, infoText: 'Your wallet or exchange may have its own minimum withdrawal amount and fee. Please check before sending.' }),
  });

  const paymentSources = Object.freeze(Object.entries(sendingSources).map(([id, source]) => Object.freeze({
    id,
    enabled: true,
    label: source.label,
    minimumTickets: source.minTickets,
    minimumWithdrawal: source.minimumWithdrawal,
    warningText: source.warningText || '',
    infoText: source.infoText || '',
  })));

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
    sendingSources,
  };
});
