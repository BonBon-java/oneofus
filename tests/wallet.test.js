const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TronWalletController,
  createTronLinkDappUrl,
  isMobileBrowser,
} = require('../wallet.js');

function createProvider({ address = 'TX8fExampleAddress00000000000002Qa', requestError } = {}) {
  const listeners = new Map();
  const provider = {
    isTronLink: true,
    tronWeb: {
      ready: true,
      defaultAddress: { base58: address },
      fullNode: { host: 'https://nile.trongrid.io' },
    },
    async request({ method }) {
      if (requestError && method === 'eth_requestAccounts') throw requestError;
      if (method === 'eth_requestAccounts') return [address];
      if (method === 'eth_chainId') return '0xcd8690dc';
      throw new Error(`Unexpected method: ${method}`);
    },
    on(eventName, listener) {
      listeners.set(eventName, listener);
    },
    removeListener(eventName) {
      listeners.delete(eventName);
    },
    emit(eventName, payload) {
      return listeners.get(eventName)?.(payload);
    },
  };

  return provider;
}

function createWindow(provider) {
  return {
    tron: provider,
    Event,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
  };
}

test('connects to an available TronLink provider and detects Nile', async () => {
  const provider = createProvider();
  const wallet = new TronWalletController({ windowObject: createWindow(provider) });
  const state = await wallet.connect();

  assert.equal(state.status, 'connected');
  assert.equal(state.address, 'TX8fExampleAddress00000000000002Qa');
  assert.equal(state.network.name, 'Nile Testnet');
});

test('reports when a wallet provider is absent', async () => {
  const wallet = new TronWalletController({
    windowObject: createWindow(null),
    detectionTimeout: 1,
  });

  await assert.rejects(wallet.connect(), { code: 'wallet_not_found' });
  assert.equal(wallet.state.status, 'unavailable');
});

test('maps a rejected authorization request', async () => {
  const provider = createProvider({ requestError: { code: 4001, message: 'Rejected' } });
  const wallet = new TronWalletController({ windowObject: createWindow(provider) });

  await assert.rejects(wallet.connect(), { code: 'connection_rejected' });
  assert.equal(wallet.state.status, 'idle');
});

test('updates the connected address after an account change', async () => {
  const provider = createProvider();
  const wallet = new TronWalletController({ windowObject: createWindow(provider) });
  await wallet.connect();
  await provider.emit('accountsChanged', ['TNewAccount000000000000000000000002Qa']);

  assert.equal(wallet.state.address, 'TNewAccount000000000000000000000002Qa');
  assert.equal(wallet.state.status, 'connected');
});

test('treats an empty account event as a disconnect or locked wallet', async () => {
  const provider = createProvider();
  const wallet = new TronWalletController({ windowObject: createWindow(provider) });
  await wallet.connect();
  await provider.emit('accountsChanged', []);

  assert.equal(wallet.state.address, null);
  assert.equal(wallet.state.status, 'disconnected');
});

test('creates the official TronLink open-DApp deep link without a callback', () => {
  const deepLink = createTronLinkDappUrl('https://bonbon-java.github.io/oneofus/');
  const payload = JSON.parse(decodeURIComponent(deepLink.split('param=')[1]));

  assert.equal(payload.action, 'open');
  assert.equal(payload.protocol, 'TronLink');
  assert.equal(payload.url, 'https://bonbon-java.github.io/oneofus/');
  assert.equal(payload.callbackUrl, undefined);
});

test('detects mobile browsers including iPad desktop mode', () => {
  assert.equal(isMobileBrowser({ userAgent: 'Mozilla/5.0 (iPhone)' }), true);
  assert.equal(isMobileBrowser({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(isMobileBrowser({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 }), false);
});
