(function exposePaymentModal(root, factory) {
  const api = factory(
    root.OneOfUsPaymentSources,
    root.OneOfUsPaymentSession,
  );
  root.OneOfUsPaymentModal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, (sourcesApi, sessionApi) => {
  const { getMinimumTickets, paymentSources } = sourcesApi;
  const { PaymentDraft, createPaymentSessionService } = sessionApi;

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
      this.minimum = rootElement.querySelector('[data-ticket-minimum]');

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
      const minimum = this.draft.minimumTickets;
      this.value.textContent = String(tickets);
      this.summary.textContent = `${tickets} ${tickets === 1 ? 'ticket' : 'tickets'} = ${tickets} USDT`;
      this.minimum.textContent = this.draft.source?.minimumVerified
        ? `Minimum from this exchange: ${minimum} ${minimum === 1 ? 'ticket' : 'tickets'}`
        : 'Minimum pending provider confirmation; demo starts at 1 ticket.';
      this.minus.disabled = tickets <= minimum;
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
        <div class="payment-detail-row">
          <span>Network</span><strong>${escapeHtml(session.network)}</strong>
        </div>
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
      this.service = createPaymentSessionService(config);
      this.session = null;
      this.step = 1;
      this.lastFocused = null;
      this.closeTimer = null;

      this.trigger.addEventListener('click', () => this.open());
      this.closeButton.addEventListener('click', () => this.close());
      this.root.addEventListener('click', (event) => {
        if (event.target === this.root || event.target.matches('.payment-modal-backdrop')) this.close();
      });
      document.addEventListener('keydown', (event) => this.handleKeydown(event));
      this.renderStepOne();
    }

    open() {
      clearTimeout(this.closeTimer);
      this.lastFocused = document.activeElement;
      this.root.hidden = false;
      document.body.classList.add('modal-open');
      requestAnimationFrame(() => this.root.classList.add('is-open'));
      setTimeout(() => this.content.querySelector('input, select, button')?.focus(), 50);
    }

    close() {
      this.root.classList.remove('is-open');
      document.body.classList.remove('modal-open');
      this.closeTimer = setTimeout(() => {
        this.root.hidden = true;
        this.lastFocused?.focus?.();
      }, 180);
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

    renderDemoNotice() {
      return this.config.mode === 'demo'
        ? '<p class="demo-notice"><strong>DEMO PAYMENT FLOW</strong><span>Do not send funds. The address below is intentionally invalid.</span></p>'
        : '';
    }

    renderStepOne() {
      this.step = 1;
      this.content.innerHTML = `
        <div class="payment-step" data-step="1">
          <div class="payment-heading"><span>GET IN</span><h2 id="payment-modal-title">Join today.</h2><p>No account or registration required.</p></div>
          ${this.renderDemoNotice()}
          <label class="payment-field">
            <span>Your name today <small>Optional</small></span>
            <input type="text" maxlength="28" placeholder="Nikita" value="${escapeHtml(this.draft.displayName)}" data-display-name />
          </label>
          <div class="payment-field">
            <span>Tickets</span>
            <div class="ticket-selector">
              <button type="button" aria-label="Remove one ticket" data-ticket-minus>−</button>
              <strong aria-live="polite" data-ticket-value>${this.draft.tickets}</strong>
              <button type="button" aria-label="Add one ticket" data-ticket-plus>+</button>
            </div>
            <strong class="ticket-summary" data-ticket-summary></strong>
            <small class="field-note" data-ticket-minimum></small>
          </div>
          <label class="payment-field">
            <span>Where are you sending from?</span>
            <select data-payment-source></select>
          </label>
          <div class="source-instruction" data-source-instruction></div>
          <p class="field-note">Withdrawal minimums may change depending on the exchange.</p>
          <div class="payment-warning">
            <strong>Your exchange may charge a withdrawal fee.</strong>
            <span>The fee is set by your exchange and is not charged by One of Us.</span>
            <span>Make sure you select <b>Arbitrum One</b> when withdrawing USDT.</span>
          </div>
          <div class="network-pill"><span>Network</span><strong>Arbitrum One</strong></div>
          <p class="network-warning"><strong>Only send USDT using Arbitrum One.</strong><br />Sending through another network may result in loss of funds.</p>
          <p class="payment-error" role="alert" data-payment-error></p>
          <button class="payment-action" type="button" data-continue>Continue <span>→</span></button>
        </div>
      `;

      const nameInput = this.content.querySelector('[data-display-name]');
      const instruction = this.content.querySelector('[data-source-instruction]');
      const ticketSelector = new TicketSelector(this.content, this.draft);
      const renderSource = (source) => {
        instruction.innerHTML = `<strong>${escapeHtml(source.label)}</strong><span>${escapeHtml(source.instruction)}</span><small>${escapeHtml(source.feeText)}</small>`;
        ticketSelector.render();
      };
      new PaymentSourceSelector(this.content.querySelector('[data-payment-source]'), this.draft, renderSource);
      renderSource(this.draft.source);

      nameInput.addEventListener('input', () => this.draft.setDisplayName(nameInput.value));
      this.content.querySelector('[data-continue]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const errorElement = this.content.querySelector('[data-payment-error]');
        button.disabled = true;
        errorElement.textContent = '';
        try {
          this.session = await this.service.createPaymentSession(this.draft.toRequest());
          this.renderStepTwo();
        } catch (error) {
          errorElement.textContent = error.message || 'Payment session is unavailable.';
        } finally {
          button.disabled = false;
        }
      });
    }

    renderStepTwo() {
      this.step = 2;
      this.content.innerHTML = `
        <div class="payment-step" data-step="2">
          <button class="payment-back" type="button" data-back>← Back</button>
          <div class="payment-heading"><span>PAYMENT DETAILS</span><h2 id="payment-modal-title">Send USDT</h2><p>Use the exact details shown for this payment session.</p></div>
          ${this.renderDemoNotice()}
          <div class="payment-details" data-payment-details></div>
          <div class="payment-warning compact">
            <strong>Only send USDT using Arbitrum One.</strong>
            <span>Your exchange may deduct its withdrawal fee from the amount sent.</span>
          </div>
          <p class="session-expiry">Session expires: <time>${escapeHtml(new Date(this.session.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time></p>
          <button class="payment-action" type="button" data-sent>I've sent it <span>→</span></button>
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
          <div class="payment-heading"><span>PAYMENT STATUS</span><h2 id="payment-modal-title">Waiting for payment</h2><p class="waiting-line"><i></i> Waiting for an Arbitrum One transaction</p></div>
          ${this.renderDemoNotice()}
          <dl class="waiting-summary">
            <div><dt>Tickets</dt><dd>${this.session.tickets}</dd></div>
            <div><dt>Expected amount</dt><dd>${escapeHtml(this.session.expectedAmount)} USDT</dd></div>
            <div><dt>Network</dt><dd>${escapeHtml(this.session.network)}</dd></div>
            <div><dt>Recipient</dt><dd><code>${escapeHtml(this.session.recipient)}</code></dd></div>
          </dl>
          <div class="txid-block">
            <strong>Already sent?</strong>
            <label class="payment-field"><span>Transaction ID / TxID</span><input type="text" autocomplete="off" spellcheck="false" placeholder="Paste transaction ID" data-txid /></label>
            <button class="payment-secondary" type="button" data-check-payment>Check payment</button>
            <p class="field-note" role="status" data-check-status></p>
          </div>
        </div>
      `;
      this.content.querySelector('[data-back]').addEventListener('click', () => this.renderStepTwo());
      this.content.querySelector('[data-check-payment]').addEventListener('click', () => {
        const txid = this.content.querySelector('[data-txid]').value.trim();
        this.content.querySelector('[data-check-status]').textContent = txid
          ? 'Payment checking will be connected to the backend in the next stage.'
          : 'Enter a Transaction ID to continue.';
      });
      this.content.querySelector('[data-back]').focus();
    }
  }

  return { GetInModal };
});
