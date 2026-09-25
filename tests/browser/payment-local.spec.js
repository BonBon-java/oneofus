'use strict';
const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');
const { ethers } = require('ethers');
const { migrate } = require('../../db.js');
const { PostgresRepository } = require('../../postgres-repository.js');
const { PaymentService } = require('../../payment-service.js');
const { ArbitrumPaymentMonitor } = require('../../payment-monitor.js');
const { paymentNetwork } = require('../../payment-network.js');
const { createServer } = require('../../server.js');

test('GET IN → real MockUSDT → monitor → confirmed ledger → UI, reload and restart', async ({ page }, info) => {
  test.skip(process.env.RUN_PAYMENT_E2E !== 'true', 'Run node scripts/audit-local.js tests/browser/payment-local.spec.js');
  test.setTimeout(90000);
  expect(process.env.PGOPTIONS).toMatch(/search_path=audit_\d+_\d+$/);
  const rpcUrl = process.env.ONE_OF_US_PAYOUT_RPC_URL;
  const target = paymentNetwork({ ONE_OF_US_PAYMENT_MODE: 'local', ARBITRUM_RPC_URL: rpcUrl, ONE_OF_US_PAYMENT_TOKEN_ADDRESS: process.env.ONE_OF_US_PAYOUT_TOKEN_ADDRESS });
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const receivingAddress = ethers.Wallet.createRandom().address;
  const wallet = ethers.Wallet.createRandom().address;
  const token = new ethers.Contract(target.tokenAddress, ['function transfer(address,uint256) returns (bool)'], new ethers.NonceManager(new ethers.Wallet(process.env.ONE_OF_US_PAYOUT_PRIVATE_KEY, provider)));
  let pool, repository, service, monitor, server, baseUrl;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function start(port = 0) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(pool);
    repository = new PostgresRepository(pool);
    service = new PaymentService(repository, receivingAddress, target);
    monitor = new ArbitrumPaymentMonitor({ repository, service, rpcUrl, receivingAddress, target, confirmations: 3 });
    await monitor.verifyNetwork(); await monitor.verifyTokenDecimals();
    server = createServer({ repository, service });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { await new Promise((resolve) => server.close(resolve)); await pool.end(); }
  async function counts(orderId) {
    return (await pool.query(`SELECT o.payment_status, o.round_id, o.participant_id, o.ticket_range_start, o.ticket_range_end,
      (SELECT count(*)::int FROM ticket_ledger_entries WHERE order_id=o.id) AS ledger_count,
      (SELECT count(*)::int FROM ticket_ranges WHERE order_id=o.id) AS range_count
      FROM orders o WHERE o.id=$1`, [orderId])).rows[0];
  }
  await start();
  try {
    await page.goto(baseUrl);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.locator('#get-in-button').click();
    const modal = page.locator('#get-in-modal');
    await expect(modal).toBeVisible();
    const walletInput = page.locator('[data-payout-wallet]');
    await walletInput.click();
    await walletInput.pressSequentially('invalid');
    await expect(walletInput).toHaveValue('invalid');
    await expect(page.locator('[data-wallet-feedback]')).toContainText('valid EVM');
    await expect(page.locator('[data-continue]')).toBeDisabled();
    await page.locator('[data-display-name]').fill('Audit buyer');
    await walletInput.fill(wallet);
    await page.locator('[data-ticket-plus]').click();
    await page.screenshot({ path: info.outputPath('payment-form.png') });
    const created = page.waitForResponse((r) => r.url().endsWith('/api/orders') && r.request().method() === 'POST');
    await page.locator('[data-continue]').click();
    const order = await (await created).json();
    expect(order.chainId).toBe(31337); expect(order.tickets).toBe(2);
    await expect(page.locator('.send-exact')).toContainText(`${order.expectedAmount} USDT`);
    expect((await counts(order.orderId)).ledger_count).toBe(0);
    // Reload before sending must recover the same authoritative order.
    await page.reload(); await page.locator('#get-in-button').click();
    await expect(page.locator('.send-exact')).toContainText(`${order.expectedAmount} USDT`);
    expect(await page.evaluate(() => localStorage.getItem('oneofus-pending-order'))).toBe(order.orderId);
    expect((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(1);
    await page.locator('[data-sent]').click();
    const receipt = await (await token.transfer(receivingAddress, ethers.parseUnits(order.expectedAmount, 6))).wait();
    await monitor.scan();
    expect((await counts(order.orderId)).payment_status).toBe('payment_detected');
    expect((await counts(order.orderId)).ledger_count).toBe(0);
    await expect(page.locator('[data-check-status]')).toContainText('Payment detected', { timeout: 8000 });
    // Restart the actual HTTP API, pool, repository and monitor after detection.
    const port = server.address().port; await stop(); await start(port);
    await page.locator('[data-payment-close]').click();
    await expect(modal).toBeHidden();
    await page.locator('#get-in-button').click();
    await provider.send('hardhat_mine', ['0x2']);
    await Promise.all([monitor.scan(), monitor.scan()]);
    await expect(modal).toContainText("You're in.", { timeout: 8000 });
    await expect(modal).toContainText('#000001 – #000002');
    await page.screenshot({ path: info.outputPath('payment-success.png') });
    await expect(page.locator('[data-middle-card]')).toContainText('2 tickets', { timeout: 2000 });
    await expect(page.locator('[data-activity-list]')).toContainText('Audit buyer', { timeout: 2000 });
    const issued = await counts(order.orderId);
    expect(issued.payment_status).toBe('paid'); expect(issued.ledger_count).toBe(1); expect(issued.range_count).toBe(1);
    const ledger = (await pool.query('SELECT * FROM ticket_ledger_entries WHERE order_id=$1', [order.orderId])).rows[0];
    expect(ledger.round_id).toBe(issued.round_id); expect(ledger.participant_id).toBe(order.participantId);
    const payment = (await pool.query('SELECT * FROM payments WHERE id=$1', [ledger.payment_id])).rows[0];
    expect(payment.payment_status).toBe('confirmed'); expect(payment.transaction_hash).toBe(receipt.hash.toLowerCase());
    const raw = (await provider.send('eth_getTransactionReceipt', [receipt.hash])).logs[0];
    await monitor.scan(); await monitor.recordLog(raw);
    await monitor.recordLog({ ...raw, logIndex: '0x1' });
    for (let i = 0; i < 5; i++) expect((await (await page.request.get(`${baseUrl}/api/orders/${order.orderId}`)).json()).paymentStatus).toBe('paid');
    expect(await counts(order.orderId)).toEqual(issued);
    const duplicate = await (await token.transfer(receivingAddress, ethers.parseUnits(order.expectedAmount, 6))).wait();
    await monitor.scan();
    expect((await pool.query('SELECT payment_status FROM payments WHERE transaction_hash=$1', [duplicate.hash])).rows[0].payment_status).toBe('duplicate_payment');
    expect(await counts(order.orderId)).toEqual(issued);
    await page.locator('[data-done]').click();
    await page.reload();
    await expect(page.locator('[data-middle-card]')).toContainText('#000001–000002');
    expect(await page.evaluate(() => localStorage.getItem('oneofus-participant-id'))).toBe(order.participantId);
    await page.locator('#get-in-button').click();
    await expect(page.locator('[data-payout-wallet]')).toHaveValue(wallet);
    await expect(page.locator('[data-display-name]')).toHaveValue('Audit buyer');
    await page.locator('[data-payment-close]').click();
    await expect(modal).toBeHidden();
    await page.screenshot({ path: info.outputPath('payment-confirmed.png'), fullPage: true });
    expect((await page.request.post(`${baseUrl}/api/orders`, { data: { payoutWallet: 'bad', source: 'other', tickets: 1 } })).status()).toBe(400);
    expect((await page.request.get(`${baseUrl}/api/orders/00000000-0000-0000-0000-000000000000`)).status()).toBe(404);
    const pending = await service.create({ payoutWallet: wallet, tickets: 3, source: 'other' });
    const wrong = await (await token.transfer(receivingAddress, 200000n)).wait(); await monitor.scan();
    expect((await repository.getOrder(pending.id)).payment_status).toBe('pending');
    expect((await pool.query('SELECT payment_status FROM payments WHERE transaction_hash=$1', [wrong.hash])).rows[0].payment_status).toBe('unmatched');
    const changed = await service.create({ participantId: order.participantId, payoutWallet: ethers.Wallet.createRandom().address, tickets: 1, source: 'other' });
    expect(changed.participant_id).not.toBe(order.participantId);
    expect((await repository.getOrder(order.orderId)).payout_wallet).toBe(wallet.toLowerCase());
    await pool.query("UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=$1", [pending.id]);
    const late = await (await token.transfer(receivingAddress, BigInt(pending.expected_payment_amount))).wait();
    await monitor.scan();
    expect((await repository.getOrder(pending.id)).payment_status).toBe('late_payment');
    expect((await counts(pending.id)).ledger_count).toBe(0);
    expect((await pool.query('SELECT payment_status FROM payments WHERE transaction_hash=$1', [late.hash])).rows[0].payment_status).toBe('late_payment');
    await page.evaluate((id) => localStorage.setItem('oneofus-pending-order', id), pending.id);
    await page.reload(); await page.locator('#get-in-button').click();
    await expect(modal).toContainText('Payment arrived too late.');
    await page.locator('[data-payment-close]').click(); await expect(modal).toBeHidden();
    await page.evaluate(() => localStorage.setItem('oneofus-pending-order', '00000000-0000-0000-0000-000000000000'));
    await page.reload(); await page.locator('#get-in-button').click();
    await expect(page.locator('[data-payout-wallet]')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('oneofus-pending-order'))).toBe(null);
    expect(errors).toEqual([]);
    console.log(`PAYMENT_E2E order=${order.orderId} tx=${receipt.hash} tickets=${issued.ticket_range_start}-${issued.ticket_range_end} round=${issued.round_id} participant=${order.participantId}`);
  } finally { await stop(); provider.destroy(); }
});
