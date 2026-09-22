const menuToggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('.nav-links');

function setMenu(open) {
  nav?.classList.toggle('open', open);
  menuToggle?.setAttribute('aria-expanded', String(open));
  menuToggle?.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}

menuToggle?.addEventListener('click', () => {
  setMenu(!nav?.classList.contains('open'));
});

nav?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => setMenu(false));
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && nav?.classList.contains('open')) {
    setMenu(false);
    menuToggle?.focus();
  }
});

const countdown = document.querySelector('#countdown');
const drawSchedule = {
  getNextDrawAt: window.OneOfUsCountdown.getNextUtcMidnight,
};

function updateCountdown() {
  if (countdown) {
    countdown.textContent = window.OneOfUsCountdown.getCountdownText(Date.now(), drawSchedule.getNextDrawAt);
  }
}

updateCountdown();
setInterval(updateCountdown, 1000);

const toast = document.querySelector('.toast');
let toastTimer;

function showToast(message) {
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

document.querySelectorAll('[data-toast]').forEach((button) => {
  button.addEventListener('click', () => {
    showToast(button.dataset.toast);
  });
});

const walletButton = document.querySelector('#wallet-connect');
const walletLabel = walletButton?.querySelector('.wallet-label');
const {
  TronWalletController,
  createTronLinkDappUrl,
  isMobileBrowser,
  shortenAddress,
} = window.OneOfUsWallet;

function renderWalletState(state) {
  if (!walletButton || !walletLabel) return;

  const connected = state.status === 'connected' && state.address;
  walletLabel.textContent = connected ? shortenAddress(state.address) : 'Connect Wallet';
  walletButton.classList.toggle('connected', Boolean(connected));
  walletButton.dataset.network = state.network?.id || '';
  walletButton.title = connected ? `${state.address} · ${state.network.name}` : 'Connect a TRON wallet';
  walletButton.setAttribute(
    'aria-label',
    connected ? `TRON wallet ${state.address}, ${state.network.name}` : 'Connect TRON wallet',
  );
}

const wallet = new TronWalletController({
  windowObject: window,
  onStateChange: renderWalletState,
});

function getWalletErrorMessage(error) {
  const messages = {
    connection_rejected: 'Wallet connection was cancelled.',
    request_pending: 'A TronLink request is already open.',
    wallet_locked: 'Unlock TronLink and try again.',
    disconnected: 'TronLink disconnected.',
    connection_failed: 'Could not connect to TronLink.',
  };

  return messages[error?.code] || 'Could not connect to TronLink.';
}

walletButton?.addEventListener('click', async () => {
  walletButton.disabled = true;
  walletButton.setAttribute('aria-busy', 'true');

  try {
    const state = await wallet.connect();
    showToast(`Connected · ${state.network.name}`);
  } catch (error) {
    if (error?.code === 'wallet_not_found' && isMobileBrowser(navigator)) {
      showToast('Opening ONEOFUS in TronLink…');
      window.location.href = createTronLinkDappUrl(window.location.href);
    } else if (error?.code === 'wallet_not_found') {
      showToast('Install or enable TronLink to connect.');
    } else {
      showToast(getWalletErrorMessage(error));
    }
  } finally {
    walletButton.disabled = false;
    walletButton.removeAttribute('aria-busy');
  }
});

wallet.restore();
