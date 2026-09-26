'use strict';
const ORGANIZER_FEE_BPS = 1500n;
const BPS_DENOMINATOR = 10_000n;
function settlementAmounts(settlementBasis) {
  const basis = BigInt(settlementBasis);
  if (basis < 0n) throw new Error('Settlement basis cannot be negative.');
  // Public payout rule: winner gets floor(85%), then every indivisible base
  // unit is assigned to the configured treasury so the two legs sum exactly.
  const winnerAmount = basis * (BPS_DENOMINATOR - ORGANIZER_FEE_BPS) / BPS_DENOMINATOR;
  const organizerFee = basis - winnerAmount;
  return { settlementBasis: basis.toString(), organizerFee: organizerFee.toString(), winnerAmount: winnerAmount.toString() };
}
module.exports = { ORGANIZER_FEE_BPS, settlementAmounts };
