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

let seconds = 4 * 3600 + 32 * 60 + 18;
const countdown = document.querySelector('#countdown');

setInterval(() => {
  seconds = Math.max(0, seconds - 1);
  const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const remainingSeconds = String(seconds % 60).padStart(2, '0');

  if (countdown) {
    countdown.textContent = `${hours}:${minutes}:${remainingSeconds}`;
  }
}, 1000);

const toast = document.querySelector('.toast');
let toastTimer;

document.querySelectorAll('[data-toast]').forEach((button) => {
  button.addEventListener('click', () => {
    if (!toast) return;

    toast.textContent = button.dataset.toast;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  });
});
