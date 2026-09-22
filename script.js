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

const getInButton = document.querySelector('#get-in-button');
const paymentModal = document.querySelector('#get-in-modal');

if (getInButton && paymentModal) {
  new window.OneOfUsPaymentModal.GetInModal({
    rootElement: paymentModal,
    triggerElement: getInButton,
    config: window.ONEOFUS_PAYMENT_CONFIG,
    showToast,
  });
}
