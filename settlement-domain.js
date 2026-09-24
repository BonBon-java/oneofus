'use strict';
const ORGANIZER_FEE_BPS = 1500n;
const BPS_DENOMINATOR = 10_000n;
function settlementAmounts(settlementBasis) {
  const basis = BigInt(settlementBasis);
  if (basis < 0n) throw new Error('Settlement basis cannot be negative.');
  const organizerFee = basis * ORGANIZER_FEE_BPS / BPS_DENOMINATOR;
  return { settlementBasis: basis.toString(), organizerFee: organizerFee.toString(), winnerAmount: (basis - organizerFee).toString() };
}
module.exports = { ORGANIZER_FEE_BPS, settlementAmounts };
