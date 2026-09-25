'use strict';
const { productionSignerConfig } = require('../payout-config.js');
const { HttpIsolatedSignerClient, ExternalPayoutSigner } = require('../payout-signer.js');

async function main() {
  if (process.env.ONE_OF_US_ENV !== 'production') throw new Error('Signer smoke is intentionally limited to ONE_OF_US_ENV=production.');
  const config = productionSignerConfig(process.env); if (!config.enabled) throw new Error('PAYOUT_ENABLED=true is required to validate the production signer configuration.');
  const signer = new ExternalPayoutSigner({ expectedAddress: config.expectedAddress, client: new HttpIsolatedSignerClient({ url: config.url, token: process.env.PAYOUT_SIGNER_AUTH_TOKEN }) });
  const identity = await signer.identity(); console.log(JSON.stringify({ ok: true, mode: identity.mode, address: identity.address }, null, 2));
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
