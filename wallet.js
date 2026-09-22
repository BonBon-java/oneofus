(function exposeWallet(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.OneOfUsWallet = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const NETWORKS = Object.freeze({
    '0x2b6653dc': Object.freeze({ id: '0x2b6653dc', name: 'Mainnet' }),
    '0x94a9059e': Object.freeze({ id: '0x94a9059e', name: 'Shasta Testnet' }),
    '0xcd8690dc': Object.freeze({ id: '0xcd8690dc', name: 'Nile Testnet' }),
  });

  class TronWalletError extends Error {
    constructor(code, message, cause) {
      super(message);
      this.name = 'TronWalletError';
      this.code = code;
      this.cause = cause;
    }
  }

  function normalizeChainId(value) {
    const chainId = typeof value === 'object' && value !== null ? value.chainId : value;
    return typeof chainId === 'string' ? chainId.toLowerCase() : null;
  }

  function getNetwork(chainId) {
    const normalized = normalizeChainId(chainId);
    return NETWORKS[normalized] || Object.freeze({ id: normalized, name: normalized ? 'Unknown network' : 'Network unavailable' });
  }

  function inferChainIdFromTronWeb(tronWeb) {
    const host = tronWeb?.fullNode?.host || tronWeb?.fullNode?.fullHost || '';
    const normalizedHost = String(host).toLowerCase();

    if (normalizedHost.includes('nile')) return NETWORKS['0xcd8690dc'].id;
    if (normalizedHost.includes('shasta')) return NETWORKS['0x94a9059e'].id;
    if (normalizedHost.includes('trongrid')) return NETWORKS['0x2b6653dc'].id;
    return null;
  }

  function shortenAddress(address) {
    if (typeof address !== 'string' || address.length < 10) return address || '';
    return `${address.slice(0, 4)}...${address.slice(-3)}`;
  }

  function createTronLinkDappUrl(url) {
    const payload = {
      url,
      action: 'open',
      protocol: 'TronLink',
      version: '1.0',
    };

    return `tronlinkoutside://pull.activity?param=${encodeURIComponent(JSON.stringify(payload))}`;
  }

  function isMobileBrowser(navigatorObject) {
    const userAgent = navigatorObject?.userAgent || '';
    const touchEnabledIpad = navigatorObject?.platform === 'MacIntel' && navigatorObject?.maxTouchPoints > 1;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || touchEnabledIpad;
  }

  function mapProviderError(error) {
    if (error instanceof TronWalletError) return error;

    if (error?.code === 4001) {
      return new TronWalletError('connection_rejected', 'Wallet connection was rejected.', error);
    }

    if (error?.code === -32002) {
      return new TronWalletError('request_pending', 'A wallet request is already open.', error);
    }

    if (error?.code === 4900) {
      return new TronWalletError('disconnected', 'The wallet is disconnected.', error);
    }

    return new TronWalletError('connection_failed', 'Unable to connect to TronLink.', error);
  }

  class TronWalletController {
    constructor({ windowObject, onStateChange = () => {}, detectionTimeout = 500 } = {}) {
      this.window = windowObject || (typeof window !== 'undefined' ? window : null);
      this.onStateChange = onStateChange;
      this.detectionTimeout = detectionTimeout;
      this.provider = null;
      this.boundProvider = null;
      this.listeners = null;
      this.state = {
        status: 'idle',
        address: null,
        network: getNetwork(null),
      };
    }

    setState(patch) {
      this.state = { ...this.state, ...patch };
      this.onStateChange({ ...this.state });
      return this.state;
    }

    async detectProvider() {
      if (this.provider) return this.provider;
      if (!this.window) return null;
      if (this.window.tron?.request) {
        this.provider = this.window.tron;
        return this.provider;
      }

      const provider = await new Promise((resolve) => {
        let settled = false;
        let timeoutId;

        const finish = (value) => {
          if (settled) return;
          settled = true;
          this.window.removeEventListener?.('TIP6963:announceProvider', onAnnouncement);
          if (timeoutId) this.window.clearTimeout?.(timeoutId);
          resolve(value);
        };

        const onAnnouncement = (event) => {
          const detail = event?.detail;
          if (detail?.provider?.isTronLink || detail?.info?.name === 'TronLink') {
            finish(detail.provider);
          }
        };

        this.window.addEventListener?.('TIP6963:announceProvider', onAnnouncement);
        const EventConstructor = this.window.Event || (typeof Event !== 'undefined' ? Event : null);
        if (EventConstructor) {
          this.window.dispatchEvent?.(new EventConstructor('TIP6963:requestProvider'));
        }
        timeoutId = this.window.setTimeout?.(() => finish(this.window.tron?.request ? this.window.tron : null), this.detectionTimeout);
        if (!this.window.setTimeout) finish(null);
      });

      this.provider = provider;
      return provider;
    }

    bindProvider(provider) {
      if (!provider?.on || this.boundProvider === provider) return;
      this.unbindProvider();

      this.listeners = {
        accountsChanged: (accounts) => this.handleAccountsChanged(accounts),
        chainChanged: (chain) => this.handleChainChanged(chain),
        connect: (chain) => this.handleConnect(chain),
        disconnect: () => this.handleDisconnect(),
      };

      Object.entries(this.listeners).forEach(([eventName, listener]) => provider.on(eventName, listener));
      this.boundProvider = provider;
    }

    unbindProvider() {
      if (!this.boundProvider?.removeListener || !this.listeners) return;
      Object.entries(this.listeners).forEach(([eventName, listener]) => this.boundProvider.removeListener(eventName, listener));
      this.boundProvider = null;
      this.listeners = null;
    }

    getAddress(accounts) {
      return accounts?.[0] || this.provider?.tronWeb?.defaultAddress?.base58 || null;
    }

    async readNetwork(chainHint) {
      let chainId = normalizeChainId(chainHint);

      if (!chainId) {
        try {
          chainId = normalizeChainId(await this.provider?.request?.({ method: 'eth_chainId' }));
        } catch {
          chainId = null;
        }
      }

      chainId ||= inferChainIdFromTronWeb(this.provider?.tronWeb);
      return getNetwork(chainId);
    }

    async connect() {
      this.setState({ status: 'connecting' });
      const provider = await this.detectProvider();

      if (!provider) {
        const error = new TronWalletError('wallet_not_found', 'TronLink is not installed.');
        this.setState({ status: 'unavailable', address: null });
        throw error;
      }

      this.bindProvider(provider);

      try {
        const accounts = await provider.request({ method: 'eth_requestAccounts' });
        const address = Array.isArray(accounts) ? accounts[0] || null : null;
        if (!address || !provider.tronWeb?.ready) {
          throw new TronWalletError('wallet_locked', 'Unlock TronLink and try again.');
        }

        const network = await this.readNetwork();
        return this.setState({ status: 'connected', address, network });
      } catch (error) {
        const mappedError = mapProviderError(error);
        this.setState({ status: mappedError.code === 'disconnected' ? 'disconnected' : 'idle', address: null });
        throw mappedError;
      }
    }

    async restore() {
      const provider = await this.detectProvider();
      if (!provider) return this.setState({ status: 'unavailable', address: null });

      this.bindProvider(provider);
      const address = provider.tronWeb?.ready ? this.getAddress() : null;
      if (!address) return this.setState({ status: 'idle', address: null });

      const network = await this.readNetwork();
      return this.setState({ status: 'connected', address, network });
    }

    async handleAccountsChanged(accounts) {
      const address = Array.isArray(accounts) ? accounts[0] || null : null;
      if (!address) return this.handleDisconnect();
      const network = await this.readNetwork();
      return this.setState({ status: 'connected', address, network });
    }

    handleChainChanged(chain) {
      return this.setState({ network: getNetwork(chain) });
    }

    async handleConnect(chain) {
      const address = this.getAddress();
      const network = await this.readNetwork(chain);
      return this.setState({ status: address ? 'connected' : 'idle', address, network });
    }

    handleDisconnect() {
      return this.setState({ status: 'disconnected', address: null });
    }
  }

  return {
    NETWORKS,
    TronWalletController,
    TronWalletError,
    createTronLinkDappUrl,
    getNetwork,
    inferChainIdFromTronWeb,
    isMobileBrowser,
    mapProviderError,
    normalizeChainId,
    shortenAddress,
  };
});
