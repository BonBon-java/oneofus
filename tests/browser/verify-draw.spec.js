'use strict';
const http = require('node:http');
const { test, expect } = require('@playwright/test');
const { createServer } = require('../../server.js');

const roundId = 'a3f1c8d2-7b54-4c9e-9a6d-1f2e3b4c5d6e';
const randomness = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const transactionHash = `0x${'ab'.repeat(32)}`;
let scenario = 'verified';
let siteScenario = 'winner';
let retryCount = 0;
let releaseDelayedResponse;
let baseUrl;
let server;

function verified(overrides = {}) {
  return {
    status: 'verified', roundId, roundState: 'completed', entriesLockedAt: '2026-09-20T00:00:00.000Z', drawnAt: '2026-09-20T00:00:03.000Z', totalEligibleTickets: 42, paidTicketCount: 40, freeTicketCount: 2, snapshotHash: 'f'.repeat(64),
    drand: { network: 'quicknet', chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971', round: '12345678', scheduledAt: '2026-09-20T00:00:03.000Z' },
    publicRandomness: randomness, algorithmVersion: 'ONE_OF_US_DRAND_V1', winningTicket: '17', winnerWallet: '0x1111111111111111111111111111111111111111', prizeAmount: '35700000', payout: { status: 'pending', transactionHash: null }, ...overrides,
  };
}

function siteSummary() {
  if (siteScenario === 'unavailable') throw new Error('site API unavailable');
  const activity = siteScenario === 'recent' ? [{ id: 'recent-order', name: 'Recent buyer', tickets: 1, paidAt: '2026-09-23T12:00:00.000Z' }] : [];
  return { currentPool: { paidTickets: 42, amount: 42, minPaidTicketsForDraw: 10 }, activity, lastWinner: { roundId, winnerName: 'Winner', prizeAmount: '35.7', winningTicketNumber: 17, isDemo: false }, recentWinners: [] };
}

async function verification() {
  if (scenario === 'delayed') await new Promise((resolve) => { releaseDelayedResponse = resolve; });
  if (scenario === 'error-once' && retryCount++ === 0) throw new Error('temporary worker failure');
  if (scenario === 'legacy') return { roundId, status: 'unavailable', reason: 'verification_not_available' };
  if (scenario === 'confirmed') return verified({ payout: { status: 'confirmed', transactionHash } });
  return verified();
}

test.beforeAll(async () => {
  server = createServer({ repository: { siteSummary: async () => siteSummary(), verifyDraw: verification }, service: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
test.beforeEach(() => { scenario = 'verified'; siteScenario = 'winner'; retryCount = 0; releaseDelayedResponse = undefined; });

async function openVerify(page) {
  await page.goto(baseUrl);
  const trigger = page.getByRole('button', { name: 'Verify Draw' });
  await expect(trigger).toBeVisible();
  await trigger.click();
  return trigger;
}

test('renders recent activity and keeps the Last Winner artwork intentional when the site API is unavailable', async ({ page }) => {
  siteScenario = 'recent';
  await page.goto(baseUrl);
  await expect(page.getByText('Recent buyer')).toBeVisible();
  await expect(page.locator('.winner-orbit')).toHaveCSS('background-image', /winner-earth-opt\.jpg/);
  await expect(page.locator('[data-middle-card]')).toContainText('Winner');
  siteScenario = 'unavailable';
  await page.goto(baseUrl);
  await expect(page.locator('[data-middle-card]')).toContainText('No completed draws yet.');
  await expect(page.locator('.winner-orbit')).toHaveCSS('background-image', /winner-earth-opt\.jpg/);
  await expect(page.locator('[data-activity-list]')).toContainText('No recent activity yet.');
});

test('opens Verify Draw and renders immutable completed-draw data', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  await openVerify(page);
  const dialog = page.getByRole('dialog', { name: /winning ticket #17/i });
  await expect(dialog).toContainText('VERIFIED');
  for (const label of ['Round', 'Entries Locked', 'Drawn', 'Public Randomness', 'Total Tickets', 'Winning Ticket']) await expect(dialog).toContainText(label);
  await expect(dialog).toContainText('42');
  await expect(dialog).toContainText('#17');
  await expect(dialog.getByText('01234567…89abcdef')).toBeVisible();
  await dialog.getByRole('button', { name: 'Show full' }).click();
  await expect(dialog.getByText(randomness)).toBeVisible();
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(randomness);
  await dialog.getByText('Technical Details').click();
  await expect(dialog).toContainText('Snapshot Hash');
  await expect(dialog).toContainText('quicknet');
  await dialog.getByText('Technical Details').click();
  await expect(dialog.getByText('Snapshot Hash')).not.toBeVisible();
  await expect(dialog.getByRole('link', { name: /view on drand/i })).toHaveAttribute('href', 'https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/12345678');
});

test('traps focus, closes with Escape, and restores focus to Verify Draw', async ({ page }) => {
  await page.goto(baseUrl);
  const trigger = page.getByRole('button', { name: 'Verify Draw' });
  await trigger.focus();
  await trigger.press('Enter');
  const close = page.getByRole('button', { name: 'Close Verify Draw' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByText('Technical Details')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#verify-draw-modal')).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('close control works with keyboard and pointer', async ({ page }) => {
  await openVerify(page);
  await page.getByRole('button', { name: 'Close Verify Draw' }).press('Enter');
  await expect(page.locator('#verify-draw-modal')).toBeHidden();
  await openVerify(page);
  await page.getByRole('button', { name: 'Close Verify Draw' }).click();
  await expect(page.locator('#verify-draw-modal')).toBeHidden();
});

test('shows loading without stale draw data, then renders the response', async ({ page }) => {
  scenario = 'delayed';
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Verify Draw' }).click();
  await expect(page.getByRole('heading', { name: 'Loading verification…' })).toBeVisible();
  await expect(page.getByText('Winning Ticket #17')).not.toBeVisible();
  releaseDelayedResponse();
  await expect(page.getByRole('heading', { name: 'Winning Ticket #17' })).toBeVisible();
});

test('shows a friendly API failure and retries successfully', async ({ page }) => {
  scenario = 'error-once';
  await openVerify(page);
  await expect(page.getByText('Verification data is temporarily unavailable.')).toBeVisible();
  await expect(page.getByText('temporary worker failure')).not.toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Winning Ticket #17' })).toBeVisible();
});

test('does not fabricate verification data for a legacy draw', async ({ page }) => {
  scenario = 'legacy';
  await openVerify(page);
  const dialog = page.getByRole('dialog', { name: 'Verification unavailable' });
  await expect(dialog).toContainText('This historical draw does not have complete public verification data.');
  await expect(dialog.getByText('VERIFIED')).not.toBeVisible();
  await expect(dialog.getByText('Public Randomness')).not.toBeVisible();
});

test('shows pending and confirmed payout states without fabricating a transaction', async ({ page }) => {
  await openVerify(page);
  await expect(page.getByText('Payout pending')).toBeVisible();
  await expect(page.getByText('Paid ·')).not.toBeVisible();
  scenario = 'confirmed';
  await page.getByRole('button', { name: 'Close Verify Draw' }).click();
  await openVerify(page);
  await expect(page.getByText(`Paid · ${transactionHash.slice(0, 8)}…${transactionHash.slice(-8)}`)).toBeVisible();
});

test('keeps key Verify Draw interactions usable at a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openVerify(page);
  await expect(page.getByRole('dialog')).toContainText('Winning Ticket #17');
  await page.keyboard.press('Escape');
  await expect(page.locator('#verify-draw-modal')).toBeHidden();
});
