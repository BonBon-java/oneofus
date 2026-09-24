'use strict';

// This is intentionally a whitelist: signed transactions and signer material
// never enter an operational log, even if a caller accidentally passes them.
function payoutAudit(logger, event, intent) {
  if (!logger?.info) return;
  logger.info({ event, settlementId: intent.settlementId, payoutIntentId: intent.id, transactionHash: intent.transactionHash, chainId: intent.chainId, tokenAddress: intent.tokenAddress, recipient: intent.winnerWallet, amount: intent.winnerAmount, confirmationState: intent.status });
}

module.exports = { payoutAudit };
