(function exposePaymentModal(root, factory) {
  const api = factory(
    root.OneOfUsPaymentSources,
    root.OneOfUsPaymentSession,
  );
  root.OneOfUsPaymentModal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, (sourcesApi, sessionApi) => {
  const { getMinimumTickets, paymentSources } = sourcesApi;
  const { PaymentDraft, createPaymentSessionService } = sessionApi;
  const profileStorageKey = 'oneofus-payment-profile';
  const pendingOrderStorageKey = 'oneofus-pending-order';

  function savedProfile() {
    try {
      const profile = JSON.parse(localStorage.getItem(profileStorageKey) || '{}');
      return { displayName: String(profile.displayName || '').trim().slice(0, 28), payoutWallet: String(profile.payoutWallet || '').trim() };
    } catch { return { displayName: '', payoutWallet: '' }; }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }

    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }

  class TicketSelector {
    constructor(rootElement, draft, onChange) {
      this.root = rootElement;
      this.draft = draft;
      this.onChange = onChange;
      this.minus = rootElement.querySelector('[data-ticket-minus]');
      this.plus = rootElement.querySelector('[data-ticket-plus]');
      this.value = rootElement.querySelector('[data-ticket-value]');
      this.summary = rootElement.querySelector('[data-ticket-summary]');

      this.minus.addEventListener('click', () => {
        this.draft.decrement();
        this.render();
        this.onChange?.();
      });
      this.plus.addEventListener('click', () => {
        this.draft.increment();
        this.render();
        this.onChange?.();
      });
      this.render();
    }

    render() {
      const tickets = this.draft.tickets;
      this.value.textContent = String(tickets);
      this.summary.textContent = `${tickets} ${tickets === 1 ? 'ticket' : 'tickets'} = ${tickets} USDT`;
      this.minus.disabled = tickets <= 1;
    }
  }

  class PaymentSourceSelector {
    constructor(selectElement, draft, onChange) {
      this.select = selectElement;
      this.draft = draft;
      this.onChange = onChange;

      this.select.innerHTML = paymentSources
        .filter((source) => source.enabled)
        .map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.label)}</option>`)
        .join('');
      this.select.value = draft.sourceId;
      this.select.addEventListener('change', () => {
        this.draft.setSource(this.select.value);
        this.onChange?.(this.draft.source);
      });
    }
  }

  class PaymentDetails {
    constructor(rootElement, onCopy) {
      this.root = rootElement;
      this.onCopy = onCopy;
      this.session = null;
      this.root.addEventListener('click', (event) => {
        const button = event.target.closest('[data-copy]');
        if (!button || !this.session) return;
        const key = button.dataset.copy;
        const value = key === 'amount' ? this.session.expectedAmount : this.session.recipient;
        copyText(value)
          .then(() => this.onCopy?.(key))
          .catch(() => this.onCopy?.('error'));
      });
    }

    render(session) {
      this.session = session;
      this.root.innerHTML = `
        <div class="payment-detail-row payment-detail-stack">
          <span>Recipient</span>
          <div class="payment-copy-row"><code>${escapeHtml(session.recipient)}</code><button type="button" data-copy="address">Copy</button></div>
        </div>
        <div class="payment-detail-row payment-detail-stack">
          <span>Amount</span>
          <div class="payment-copy-row"><strong>${escapeHtml(session.expectedAmount)} USDT</strong><button type="button" data-copy="amount">Copy</button></div>
        </div>
      `;
    }
  }

  class GetInModal {
    constructor({ rootElement, triggerElement, config, showToast }) {
      this.root = rootElement;
      this.panel = rootElement.querySelector('.payment-panel');
      this.content = rootElement.querySelector('[data-payment-content]');
      this.closeButton = rootElement.querySelector('[data-payment-close]');
      this.trigger = triggerElement;
      this.config = config;
      this.showToast = showToast;
      this.draft = new PaymentDraft();
      const profile = savedProfile();
      this.draft.setDisplayName(profile.displayName);
      this.draft.setPayoutWallet(profile.payoutWallet);
      this.service = createPaymentSessionService(config);
      this.session = null;
      this.step = 1;
      this.lastFocused = null;
      this.closeTimer = null;
      this.statusTimer = null;
      this.participantId = localStorage.getItem('oneofus-participant-id');

      this.trigger.addEventListener('click', () => this.open());
      this.closeButton.addEventListener('click', () => this.close());
      this.root.addEventListener('click', (event) => {
        if (event.target === this.root || event.target.matches('.payment-modal-backdrop')) this.close();
      });
      document.addEventListener('keydown', (event) => this.handleKeydown(event));
      this.renderStepOne();
    }

    async open() {
      if (this.step === 4) this.startNewPurchase();
      clearTimeout(this.closeTimer);
      this.lastFocused = document.activeElement;
      this.root.hidden = false;
      document.body.classList.add('modal-open');
      requestAnimationFrame(() => this.root.classList.add('is-open'));
      if (this.step === 3) this.renderWaiting();
      const pendingId = localStorage.getItem(pendingOrderStorageKey);
      if (!this.session && pendingId) {
        this.content.innerHTML = '<p role="status">Restoring payment…</p>';
        try {
          const response = await fetch(`${this.config.statusEndpoint || '/api/orders/'}${encodeURIComponent(pendingId)}`);
          if (response.status === 404) { localStorage.removeItem(pendingOrderStorageKey); this.renderStepOne(); }
          else {
            if (!response.ok) throw new Error('Payment unavailable');
            this.session = await response.json();
            if (this.session.paymentStatus === 'paid') this.renderSuccess(this.session);
            else if (['expired', 'late_payment', 'cancelled'].includes(this.session.paymentStatus)) this.renderExpired();
            else if (this.session.paymentStatus === 'payment_detected') this.renderWaiting();
            else this.renderStepTwo();
          }
        } catch {
          this.content.innerHTML = '<p role="alert">Unable to restore payment. Close and reopen to retry.</p>';
        }
      }
      setTimeout(() => this.content.querySelector('input, select, button')?.focus(), 50);
    }

    close() {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
      this.root.classList.remove('is-open');
      document.body.classList.remove('modal-open');
      this.closeTimer = setTimeout(() => {
        this.root.hidden = true;
        this.lastFocused?.focus?.();
      }, 180);
    }

    startNewPurchase() {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
      const displayName = this.draft.displayName;
      const payoutWallet = this.draft.payoutWallet;
      this.draft = new PaymentDraft();
      this.draft.setDisplayName(displayName);
      this.draft.setPayoutWallet(payoutWallet);
      this.session = null;
      this.renderStepOne();
    }

    saveProfile() {
      if (!this.draft.hasValidPayoutWallet()) return;
      localStorage.setItem(profileStorageKey, JSON.stringify({ displayName: this.draft.displayName, payoutWallet: this.draft.payoutWallet }));
    }

    handleKeydown(event) {
      if (this.root.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [...this.panel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    renderStepOne() {
      this.step = 1;
      this.content.innerHTML = `
        <div class="payment-step" data-step="1">
          <div class="payment-heading"><span>GET IN</span><h2 id="payment-modal-title">Join today.</h2><p>No account or registration required.</p></div>
          <label class="payment-field">
            <span>Your name today <small>Optional</small></span>
            <input type="text" maxlength="28" placeholder="Nikita" value="${escapeHtml(this.draft.displayName)}" data-display-name />
          </label>
          <label class="payment-field">
            <span>Your wallet</span>
            <input type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="0x..." value="${escapeHtml(this.draft.payoutWallet)}" aria-describedby="payout-wallet-help payout-wallet-feedback" data-payout-wallet />
            <small class="field-note" id="payout-wallet-help">Your prize will be sent to this address.</small>
            <small class="wallet-warning">Make sure you control this address. Prizes cannot be recovered if the address is incorrect.</small>
            <small class="wallet-feedback" id="payout-wallet-feedback" role="alert" data-wallet-feedback></small>
          </label>
          <div class="payment-field">
            <span>Tickets</span>
            <div class="ticket-selector">
              <button type="button" aria-label="Remove one ticket" data-ticket-minus>−</button>
              <strong aria-live="polite" data-ticket-value>${this.draft.tickets}</strong>
              <button type="button" aria-label="Add one ticket" data-ticket-plus>+</button>
            </div>
            <strong class="ticket-summary" data-ticket-summary></strong>
          </div>
          <label class="payment-field">
            <span>Where are you sending from?</span>
            <select data-payment-source></select>
          </label>
          <div class="source-instruction" aria-live="polite" data-source-instruction></div>
          <div class="payment-warning">
            <strong>Your exchange may charge a withdrawal fee.</strong>
            <span>The fee is set by your exchange and is not charged by One of Us.</span>
          </div>
          <div class="network-pill"><strong>Network: Arbitrum One</strong><small>Sending USDT through another network may result in permanent loss of funds.</small></div>
          <p class="payment-error" role="alert" data-payment-error></p>
          <button class="payment-action" type="button" data-continue>CONTINUE</button>
        </div>
      `;

      const nameInput = this.content.querySelector('[data-display-name]');
      const walletInput = this.content.querySelector('[data-payout-wallet]');
      const instruction = this.content.querySelector('[data-source-instruction]');
      const walletFeedback = this.content.querySelector('[data-wallet-feedback]');
      const continueButton = this.content.querySelector('[data-continue]');
      let renderForm;
      const ticketSelector = new TicketSelector(this.content, this.draft, () => renderForm());
      const renderSource = (source) => {
        const hasEnoughTickets = this.draft.tickets >= this.draft.minimumTickets;
        instruction.innerHTML = source.id === 'other'
          ? `<span>${escapeHtml(source.infoText)}</span>`
          : hasEnoughTickets ? '' : `<strong>${escapeHtml(source.warningText)}</strong>`;
        ticketSelector.render();
        return hasEnoughTickets;
      };
      renderForm = () => {
        const hasWallet = this.draft.hasValidPayoutWallet();
        const walletIsEmpty = !this.draft.payoutWallet;
        walletInput.setAttribute('aria-invalid', String(!walletIsEmpty && !hasWallet));
        walletFeedback.textContent = walletIsEmpty
          ? 'Enter the wallet address where you want to receive a prize.'
          : hasWallet ? '' : 'Enter a valid EVM address (0x followed by 40 hexadecimal characters).';
        const hasEnoughTickets = renderSource(this.draft.source);
        continueButton.disabled = !hasWallet || !hasEnoughTickets;
      };
      new PaymentSourceSelector(this.content.querySelector('[data-payment-source]'), this.draft, renderForm);
      renderForm();

      nameInput.addEventListener('input', () => this.draft.setDisplayName(nameInput.value));
      walletInput.addEventListener('input', () => {
        this.draft.setPayoutWallet(walletInput.value);
        renderForm();
      });
      continueButton.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const errorElement = this.content.querySelector('[data-payment-error]');
        button.disabled = true;
        errorElement.textContent = '';
        try {
          this.session = await this.service.createPaymentSession({ ...this.draft.toRequest(), participantId: this.participantId });
          localStorage.setItem(pendingOrderStorageKey, this.session.orderId);
          this.saveProfile();
          this.participantId = this.session.participantId;
          if (this.participantId) localStorage.setItem('oneofus-participant-id', this.participantId);
          this.renderStepTwo();
        } catch (error) {
          errorElement.textContent = error.message || 'Payment session is unavailable.';
        } finally {
          button.disabled = false;
        }
      });
    }

    renderStepTwo() {
      clearInterval(this.statusTimer); this.statusTimer = null;
      this.step = 2;
      this.content.innerHTML = `
        <div class="payment-step" data-step="2">
          <button class="payment-back" type="button" data-back>← Back</button>
          <div class="payment-heading"><span>PAYMENT DETAILS</span><h2 id="payment-modal-title">Send USDT</h2><p>Use the exact details shown for this payment session.</p></div>
          <div class="payment-details" data-payment-details></div>
          <p class="send-exact">Send exactly <strong>${escapeHtml(this.session.expectedAmount)} USDT</strong></p>
          <div class="payment-warning compact">
            <strong>Your exchange may charge a withdrawal fee.</strong>
            <span>Your exchange may deduct its withdrawal fee from the amount sent.</span>
          </div>
          <div class="network-pill"><strong>Network: ${escapeHtml(this.session.network)}</strong><small>Sending USDT through another network may result in permanent loss of funds.</small></div>
          <p class="session-expiry">Payment amount reserved for ${escapeHtml(this.session.reservationMinutes)} minutes. Expires: <time>${escapeHtml(new Date(this.session.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time></p>
          <button class="payment-action" type="button" data-sent>CONTINUE</button>
        </div>
      `;
      new PaymentDetails(this.content.querySelector('[data-payment-details]'), (key) => {
        this.showToast(key === 'error' ? 'Could not copy.' : `${key === 'amount' ? 'Amount' : 'Address'} copied.`);
      }).render(this.session);
      this.content.querySelector('[data-back]').addEventListener('click', () => this.renderStepOne());
      this.content.querySelector('[data-sent]').addEventListener('click', () => this.renderWaiting());
      this.content.querySelector('[data-back]').focus();
    }

    renderWaiting() {
      this.step = 3;
      this.content.innerHTML = `
        <div class="payment-step" data-step="3">
          <button class="payment-back" type="button" data-back>← Back</button>
          <div class="payment-heading"><span>PAYMENT STATUS</span><h2 id="payment-modal-title">Waiting for payment</h2><p class="waiting-line"><i></i> Waiting for a ${escapeHtml(this.session.network)} transaction</p></div>
          <dl class="waiting-summary">
            <div><dt>Tickets</dt><dd>${this.session.tickets}</dd></div>
            <div><dt>Expected amount</dt><dd>${escapeHtml(this.session.expectedAmount)} USDT</dd></div>
            <div><dt>Network</dt><dd>${escapeHtml(this.session.network)}</dd></div>
            <div><dt>Recipient</dt><dd><code>${escapeHtml(this.session.recipient)}</code></dd></div>
          </dl>
          <p class="field-note" role="status" data-check-status>Checking automatically. This can take a few minutes for confirmations.</p>
        </div>
      `;
      this.content.querySelector('[data-back]').addEventListener('click', () => this.renderStepTwo());
      clearInterval(this.statusTimer);
      this.statusTimer = setInterval(() => this.refreshPaymentStatus(), 5000);
      this.refreshPaymentStatus();
      this.content.querySelector('[data-back]').focus();
    }

    async refreshPaymentStatus() {
      if (!this.session?.orderId || this.step !== 3) return;
      const orderId = this.session.orderId;
      try {
        const response = await fetch(`${this.config.statusEndpoint || '/api/orders/'}${encodeURIComponent(this.session.orderId)}`);
        if (!response.ok) throw new Error('Unable to check payment status.');
        const order = await response.json();
        if (this.session?.orderId !== orderId || this.step !== 3 || this.root.hidden) return;
        this.session = { ...this.session, ...order };
        if (order.paymentStatus === 'paid') {
          this.participantId = order.participantId;
          localStorage.setItem('oneofus-participant-id', order.participantId);
          document.dispatchEvent(new CustomEvent('oneofus:order-paid', { detail: order }));
          this.renderSuccess(order);
        }
        else if (['expired', 'late_payment', 'cancelled'].includes(order.paymentStatus)) this.renderExpired();
        else this.content.querySelector('[data-check-status]').textContent = order.paymentStatus === 'payment_detected' ? 'Payment detected. Waiting for network confirmations.' : 'Checking automatically. This can take a few minutes for confirmations.';
      } catch (error) { const status = this.content.querySelector('[data-check-status]'); if (status) status.textContent = 'Unable to check payment status. Retrying…'; }
    }

    renderSuccess(order) {
      localStorage.removeItem(pendingOrderStorageKey);
      clearInterval(this.statusTimer); this.statusTimer = null; this.step = 4;
      const ticketText = order.ticketRangeStart === order.ticketRangeEnd ? `#${String(order.ticketRangeStart).padStart(6, '0')}` : `#${String(order.ticketRangeStart).padStart(6, '0')} – #${String(order.ticketRangeEnd).padStart(6, '0')}`;
      const wallet = `${order.payoutWallet.slice(0, 6)}…${order.payoutWallet.slice(-4)}`;
      this.content.innerHTML = `<div class="payment-step"><div class="payment-heading"><span>PAYMENT CONFIRMED</span><h2 id="payment-modal-title">You're in.</h2><p>${order.tickets} ${order.tickets === 1 ? 'ticket' : 'tickets'}</p></div><dl class="waiting-summary"><div><dt>Your tickets</dt><dd>${ticketText}</dd></div><div><dt>Payout wallet</dt><dd><code>${escapeHtml(wallet)}</code></dd></div></dl><button class="payment-action" type="button" data-done>DONE</button></div>`;
      this.content.querySelector('[data-done]').addEventListener('click', () => this.close());
    }

    renderExpired() {
      localStorage.removeItem(pendingOrderStorageKey);
      clearInterval(this.statusTimer); this.statusTimer = null; this.step = 4;
      const late = this.session?.paymentStatus === 'late_payment';
      this.content.innerHTML = `<div class="payment-step"><div class="payment-heading"><span>${late ? 'LATE PAYMENT' : 'PAYMENT EXPIRED'}</span><h2 id="payment-modal-title">${late ? 'Payment arrived too late.' : 'This request expired.'}</h2><p>${late ? 'Your transfer was recorded, but no tickets were issued. Do not send this payment again.' : 'Create a new request to reserve a new payment amount.'}</p></div><button class="payment-action" type="button" data-restart>GET IN</button></div>`;
      this.content.querySelector('[data-restart]').addEventListener('click', () => this.startNewPurchase());
    }
  }

  return { GetInModal };
});
