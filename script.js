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
const participantStorageKey = 'oneofus-participant-id';
const poolElement = document.querySelector('[data-current-pool]');
const rolloverElement = document.querySelector('[data-pool-rollover]');
const activityList = document.querySelector('[data-activity-list]');
const middleCard = document.querySelector('[data-middle-card]');
const winsList = document.querySelector('[data-wins-list]');
const winnersModal = document.querySelector('#winners-modal');
const verifyModal = document.querySelector('#verify-draw-modal');
let verifyTrigger = null;

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function ticketRange({ start, end }) {
  const first = `#${String(start).padStart(6, '0')}`;
  return start === end ? first : `${first}–${String(end).padStart(6, '0')}`;
}

function renderMiddleCard(entry, lastWinner) {
  if (entry?.tickets) {
    middleCard.innerHTML = `<div class="card-head"><p class="label">YOUR ENTRY</p></div><div class="winner-orbit" aria-hidden="true"></div><div class="winner-details"><p class="handle">◯ &nbsp;${escapeHtml(entry.participant.displayName)}</p><strong>${entry.tickets} ${entry.tickets === 1 ? 'ticket' : 'tickets'}</strong><p><code>${escapeHtml(entry.participant.payoutWallet)}</code></p><small class="entry-ranges">${entry.ranges.map(ticketRange).join(' · ')}</small></div>`;
    return;
  }
  if (!lastWinner) { middleCard.innerHTML = '<div class="card-head"><p class="label">LAST WINNER</p></div><div class="winner-orbit" aria-hidden="true"></div><div class="winner-details"><p class="entry-empty">No completed draws yet.</p></div>'; return; }
  middleCard.innerHTML = `<div class="card-head"><p class="label">LAST WINNER</p><span class="badge">${lastWinner.isDemo ? 'SAMPLE' : 'WIN'}</span></div><div class="winner-orbit" aria-hidden="true"></div><div class="winner-details"><p class="handle">◯ &nbsp;${escapeHtml(lastWinner.winnerName)}</p><strong>$${escapeHtml(lastWinner.prizeAmount)}</strong><p>Ticket #${escapeHtml(lastWinner.winningTicketNumber)}</p><small>${lastWinner.isDemo ? 'Sample draw data' : 'Verified on-chain'}</small>${lastWinner.roundId ? `<button class="verify-draw-btn" type="button" data-verify-draw="${escapeHtml(lastWinner.roundId)}">Verify Draw</button>` : ''}</div>`;
}

function renderSiteData(data, entry) {
  poolElement.textContent = `$${data.currentPool.amount}`;
  rolloverElement.hidden = data.currentPool.paidTickets >= data.currentPool.minPaidTicketsForDraw;
  rolloverElement.textContent = `If fewer than ${data.currentPool.minPaidTicketsForDraw} paid tickets are reached today, the pool rolls over to tomorrow.`;
  activityList.innerHTML = data.activity.length ? data.activity.map((item) => `<li><b>${escapeHtml(item.name)}</b><span>just got ${item.tickets} ${item.tickets === 1 ? 'ticket' : 'tickets'}</span><time>${relativeTime(item.paidAt)}</time></li>`).join('') : '<li class="activity-empty">No paid entries yet.</li>';
  renderMiddleCard(entry, data.lastWinner);
  winsList.innerHTML = data.recentWinners.length ? data.recentWinners.map((draw) => `<li><span class="ring"></span><div><b>$${escapeHtml(draw.prizeAmount)}</b><small>${escapeHtml(draw.winnerName)} · #${escapeHtml(draw.winningTicketNumber)}${draw.isDemo ? ' · sample' : ''}</small></div><time>${relativeTime(draw.drawDate)}</time></li>`).join('') : '<li class="winners-empty">No completed draws yet.</li>';
}

// Keep the cards intentional when the API is temporarily unavailable (for
// example, when the static frontend is opened without its API host).
renderMiddleCard(null, null);
activityList.innerHTML = '<li class="activity-empty">No recent activity yet.</li>';
winsList.innerHTML = '<li class="winners-empty">No completed draws yet.</li>';

async function loadSiteData() {
  try {
    const response = await fetch('/api/site'); if (!response.ok) return;
    const data = await response.json(); const participantId = localStorage.getItem(participantStorageKey);
    let entry = null;
    if (participantId) { const entryResponse = await fetch(`/api/participants/${encodeURIComponent(participantId)}/entries`); if (entryResponse.ok) entry = await entryResponse.json(); }
    renderSiteData(data, entry);
  } catch { /* The static layout remains usable while the API is unavailable. */ }
}

async function openWinners() {
  const response = await fetch('/api/draws'); if (!response.ok) return;
  const { draws } = await response.json(); const list = winnersModal.querySelector('[data-all-winners]'); const note = winnersModal.querySelector('[data-winners-note]');
  note.textContent = draws.some((draw) => draw.isDemo) ? 'Sample records shown in this development environment.' : '';
  list.innerHTML = draws.length ? draws.map((draw) => `<li><div><b>${escapeHtml(draw.winnerName)}</b><small>${escapeHtml(draw.winnerWallet)} · Ticket #${escapeHtml(draw.winningTicketNumber)}${draw.isDemo ? ' · sample' : ''}</small></div><div><b>$${escapeHtml(draw.prizeAmount)}</b><small>${new Date(draw.drawDate).toLocaleDateString()}</small></div></li>`).join('') : '<li class="winners-empty">No completed draws yet.</li>';
  winnersModal.hidden = false; document.body.classList.add('modal-open'); requestAnimationFrame(() => winnersModal.classList.add('is-open'));
}

function closeWinners() { winnersModal.classList.remove('is-open'); document.body.classList.remove('modal-open'); setTimeout(() => { winnersModal.hidden = true; }, 180); }

function shortValue(value) { return value && value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value; }
function tokenAmount(units) { return units === null ? '—' : (Number(units) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 }); }
function openVerify(roundId, trigger) { if (!verifyModal) return; verifyTrigger = trigger || verifyTrigger || document.activeElement; const content = verifyModal.querySelector('[data-verify-content]'); content.innerHTML = '<div class="payment-heading"><span>VERIFY DRAW</span><h2 id="verify-draw-title">Loading verification…</h2></div>'; verifyModal.hidden = false; document.body.classList.add('modal-open'); requestAnimationFrame(() => { verifyModal.classList.add('is-open'); verifyModal.querySelector('[data-verify-close]')?.focus(); }); fetch(`/api/draws/${encodeURIComponent(roundId)}/verify`).then((response) => response.ok ? response.json() : Promise.reject()).then((data) => {
  if (data.status !== 'verified') { content.innerHTML = '<div class="payment-heading"><span>VERIFY DRAW</span><h2 id="verify-draw-title">Verification unavailable</h2><p>This historical draw does not have complete public verification data.</p></div>'; return; }
  const drandUrl = `https://api.drand.sh/${encodeURIComponent(data.drand.chainHash)}/public/${encodeURIComponent(data.drand.round)}`; const payout = data.payout?.status === 'confirmed' ? `Paid · ${shortValue(data.payout.transactionHash)}` : 'Payout pending';
  content.innerHTML = `<div class="payment-heading"><span>VERIFY DRAW · <b class="verified">VERIFIED</b></span><h2 id="verify-draw-title">Winning Ticket #${escapeHtml(data.winningTicket)}</h2><p>All entries were locked before the random number existed. The first public drand round after the lock determined the winning ticket.</p></div><div class="verify-timeline"><span>Entries Locked<br><b>${new Date(data.entriesLockedAt).toISOString().replace('.000','')}</b></span><span>Public Randomness Published<br><b>drand #${escapeHtml(data.drand.round)}</b></span><span>Winning Ticket Selected<br><b>#${escapeHtml(data.winningTicket)}</b></span></div><dl class="verify-grid"><div><dt>Round</dt><dd>${escapeHtml(data.roundId.slice(0, 8))}</dd></div><div><dt>Drawn</dt><dd>${new Date(data.drawnAt).toISOString().replace('.000','')}</dd></div><div><dt>Total Tickets</dt><dd>${data.totalEligibleTickets.toLocaleString()}</dd></div><div><dt>Winner</dt><dd>${escapeHtml(shortValue(data.winnerWallet))}</dd></div><div class="wide"><dt>Public Randomness</dt><dd><code data-randomness>${escapeHtml(shortValue(data.publicRandomness))}</code> <button type="button" data-randomness-toggle>Show full</button> <button type="button" data-copy-randomness>Copy</button></dd></div><div><dt>Prize</dt><dd>${tokenAmount(data.prizeAmount)} USDT</dd></div><div><dt>Payout</dt><dd>${escapeHtml(payout)}</dd></div></dl><p><a class="verify-source" href="${drandUrl}" target="_blank" rel="noreferrer">View on drand ↗</a></p><details><summary>Technical Details</summary><dl class="verify-grid technical"><div><dt>drand Network</dt><dd>${escapeHtml(data.drand.network)}</dd></div><div><dt>drand Chain Hash</dt><dd><code>${escapeHtml(data.drand.chainHash)}</code></dd></div><div><dt>Snapshot Hash</dt><dd><code>${escapeHtml(data.snapshotHash)}</code></dd></div><div><dt>Algorithm</dt><dd>${escapeHtml(data.algorithmVersion)}</dd></div><div><dt>Paid / Free tickets</dt><dd>${data.paidTicketCount} / ${data.freeTicketCount}</dd></div></dl></details>`;
  content.querySelector('[data-randomness-toggle]')?.addEventListener('click', (event) => { const field = content.querySelector('[data-randomness]'); const full = field.textContent === data.publicRandomness; field.textContent = full ? shortValue(data.publicRandomness) : data.publicRandomness; event.currentTarget.textContent = full ? 'Show full' : 'Show less'; }); content.querySelector('[data-copy-randomness]')?.addEventListener('click', () => navigator.clipboard?.writeText(data.publicRandomness).then(() => showToast('Randomness copied')));
}).catch(() => { content.innerHTML = '<div class="payment-heading"><span>VERIFY DRAW</span><h2 id="verify-draw-title">Verification unavailable</h2><p>Verification data is temporarily unavailable.</p><button type="button" data-verify-retry>Retry</button></div>'; content.querySelector('[data-verify-retry]')?.addEventListener('click', () => openVerify(roundId)); }); }
function closeVerify() { if (!verifyModal) return; verifyModal.classList.remove('is-open'); document.body.classList.remove('modal-open'); const trigger = verifyTrigger; verifyTrigger = null; trigger?.focus(); setTimeout(() => { verifyModal.hidden = true; }, 180); }

if (getInButton && paymentModal) {
  new window.OneOfUsPaymentModal.GetInModal({
    rootElement: paymentModal,
    triggerElement: getInButton,
    config: window.ONEOFUS_PAYMENT_CONFIG,
    showToast,
  });
}

document.querySelector('[data-view-winners]')?.addEventListener('click', openWinners);
winnersModal?.querySelector('[data-winners-close]')?.addEventListener('click', closeWinners);
winnersModal?.addEventListener('click', (event) => { if (event.target === winnersModal || event.target.matches('.payment-modal-backdrop')) closeWinners(); });
middleCard?.addEventListener('click', (event) => { const button = event.target.closest('[data-verify-draw]'); if (button) openVerify(button.dataset.verifyDraw, button); });
verifyModal?.querySelector('[data-verify-close]')?.addEventListener('click', closeVerify);
verifyModal?.addEventListener('click', (event) => { if (event.target === verifyModal || event.target.matches('.payment-modal-backdrop')) closeVerify(); });
document.addEventListener('keydown', (event) => {
  if (verifyModal?.hidden) return;
  if (event.key === 'Escape') { closeVerify(); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...verifyModal.querySelectorAll('button:not([disabled]), [href], summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0]; const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
document.addEventListener('oneofus:order-paid', (event) => { if (event.detail?.participantId) localStorage.setItem(participantStorageKey, event.detail.participantId); loadSiteData(); });
loadSiteData();
setInterval(loadSiteData, 10_000);
