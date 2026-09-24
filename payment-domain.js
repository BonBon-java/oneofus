'use strict';

const USDT_TOKEN_ADDRESS = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const USDT_DECIMALS = 6;
const ARBITRUM_CHAIN_ID = 42161;
const PAYMENT_RESERVATION_MINUTES = Number(process.env.PAYMENT_RESERVATION_MINUTES || 30);
const PAYMENT_CODE_COOLDOWN_MINUTES = Number(process.env.PAYMENT_CODE_COOLDOWN_MINUTES || 120);
const PAYMENT_CONFIRMATIONS = Number(process.env.PAYMENT_CONFIRMATIONS || 3);
const PAYMENT_SCAN_LOOKBACK_BLOCKS = Number(process.env.PAYMENT_SCAN_LOOKBACK_BLOCKS || 12);
const TOKEN_UNITS = 10n ** BigInt(USDT_DECIMALS);
const PAYMENT_IDENTIFIER_PREFIX = '00';
const PAYMENT_IDENTIFIER_MAX_DIGITS = USDT_DECIMALS - PAYMENT_IDENTIFIER_PREFIX.length;
function paymentIdentifierFor(index) {
  let offset = BigInt(index);
  if (offset < 1n) throw new Error('Payment identifier index must be positive.');
  for (let length = 1; length <= PAYMENT_IDENTIFIER_MAX_DIGITS; length += 1) {
    const capacity = 9n ** BigInt(length);
    if (offset <= capacity) {
      let value = offset - 1n; let identifier = '';
      for (let digit = 0; digit < length; digit += 1) { identifier = String(Number(value % 9n) + 1) + identifier; value /= 9n; }
      return identifier;
    }
    offset -= capacity;
  }
  throw new Error('No payment identifiers are currently available.');
}
function paymentIdentifierFromAmount(amount) {
  // The ticket price is checked separately. Within that price, zero placement
  // is deliberately ignored: 1.012 and 1.000012 both produce identifier "12".
  const fraction = (BigInt(amount) % TOKEN_UNITS).toString().padStart(USDT_DECIMALS, '0');
  return fraction.replaceAll('0', '');
}
function amountFor(tickets, code) {
  const identifier = paymentIdentifierFor(code);
  const fraction = `${PAYMENT_IDENTIFIER_PREFIX}${identifier}`;
  return BigInt(tickets) * TOKEN_UNITS + BigInt(fraction) * (10n ** BigInt(USDT_DECIMALS - fraction.length));
}
function paymentAmountsFor(tickets, code) {
  const identifier = paymentIdentifierFor(code);
  const canonical = amountFor(tickets, code);
  const fractions = new Set();
  const placeDigits = (position, identifierPosition, fraction) => {
    if (position === USDT_DECIMALS) {
      if (identifierPosition === identifier.length) fractions.add(fraction);
      return;
    }
    const remainingPositions = USDT_DECIMALS - position;
    const remainingDigits = identifier.length - identifierPosition;
    // A zero may occupy this position only when all identifier digits still fit.
    if (remainingPositions - 1 >= remainingDigits) placeDigits(position + 1, identifierPosition, fraction);
    if (identifierPosition < identifier.length) {
      const digit = BigInt(identifier[identifierPosition]);
      placeDigits(position + 1, identifierPosition + 1, fraction + digit * (10n ** BigInt(USDT_DECIMALS - position - 1)));
    }
  };
  placeDigits(0, 0, 0n);
  const base = BigInt(tickets) * TOKEN_UNITS;
  return [...fractions]
    .map((fraction) => base + fraction)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((amount) => ({ amount, kind: amount === canonical ? 'exact' : 'alias' }));
}
function formatUnits(amount) { const value = BigInt(amount); const fraction = (value % TOKEN_UNITS).toString().padStart(USDT_DECIMALS, '0').replace(/0+$/, ''); return fraction ? `${value / TOKEN_UNITS}.${fraction}` : `${value / TOKEN_UNITS}`; }
function normalizeAddress(value) { const address = String(value || '').trim().toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('A valid EVM address is required.'); return address; }
function validateOrderInput(input, sources) {
  const participantName = String(input.displayName || input.participantName || 'Anonymous').trim().slice(0, 28) || 'Anonymous';
  const payoutWallet = normalizeAddress(input.payoutWallet);
  const ticketQuantity = Number.parseInt(input.tickets ?? input.ticketQuantity, 10);
  const sendingSource = String(input.source || input.sendingSource || '');
  const source = sources.find((item) => item.id === sendingSource && item.enabled);
  if (!source) throw new Error('Select an available payment source.');
  if (!Number.isSafeInteger(ticketQuantity) || ticketQuantity < source.minimumTickets || ticketQuantity > 1000) throw new Error(`Choose between ${source.minimumTickets} and 1000 tickets.`);
  return { participantName, payoutWallet, ticketQuantity, sendingSource };
}
module.exports = { USDT_TOKEN_ADDRESS, USDT_DECIMALS, ARBITRUM_CHAIN_ID, PAYMENT_RESERVATION_MINUTES, PAYMENT_CODE_COOLDOWN_MINUTES, PAYMENT_CONFIRMATIONS, PAYMENT_SCAN_LOOKBACK_BLOCKS, PAYMENT_IDENTIFIER_MAX_DIGITS, amountFor, paymentAmountsFor, formatUnits, paymentIdentifierFor, paymentIdentifierFromAmount, normalizeAddress, validateOrderInput };
