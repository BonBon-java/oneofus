'use strict';
const { formatUnits, validateOrderInput, PAYMENT_RESERVATION_MINUTES } = require('./payment-domain.js');
const { paymentSources } = require('./payment-sources.js');
const { paymentNetwork } = require('./payment-network.js');
class PaymentService {
  constructor(repository, receivingAddress, target = paymentNetwork()) { this.repository = repository; this.receivingAddress = receivingAddress; this.target = target; }
  async create(input) { return this.repository.createOrder(validateOrderInput(input, paymentSources)); }
  async expirePending() { return this.repository.expirePending(); }
  publicOrder(order) { return { orderId: order.id, sessionId: order.id, participantId: order.participant_id, tickets: order.ticket_quantity, baseAmount: `${order.base_ticket_amount}.0000`, expectedAmount: formatUnits(order.expected_payment_amount), paymentCode: order.payment_code, source: order.sending_source, network: this.target.network, chainId: this.target.chainId, recipient: this.receivingAddress, displayName: order.participant_name, payoutWallet: order.payout_wallet, expiresAt: order.expires_at, reservationMinutes: PAYMENT_RESERVATION_MINUTES, paymentStatus: order.payment_status, ticketRangeStart: order.ticket_range_start ? Number(order.ticket_range_start) : null, ticketRangeEnd: order.ticket_range_end ? Number(order.ticket_range_end) : null, demo: false }; }
}
module.exports = { PaymentService };
