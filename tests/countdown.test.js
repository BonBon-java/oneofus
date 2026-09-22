const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCountdownText,
  getNextUtcMidnight,
  getRemainingSeconds,
} = require('../countdown.js');

test('counts down to the next UTC midnight', () => {
  const now = Date.parse('2026-09-22T18:30:00.000Z');
  assert.equal(getCountdownText(now), '05:30:00');
});

test('shows one second immediately before UTC midnight', () => {
  const now = Date.parse('2026-09-22T23:59:59.000Z');
  assert.equal(getRemainingSeconds(now), 1);
  assert.equal(getCountdownText(now), '00:00:01');
});

test('rolls to the following draw at UTC midnight', () => {
  const midnight = Date.parse('2026-09-23T00:00:00.000Z');
  assert.equal(getNextUtcMidnight(midnight), Date.parse('2026-09-24T00:00:00.000Z'));
  assert.equal(getCountdownText(midnight), '24:00:00');
});

test('a reload calculates the same countdown from the same current time', () => {
  const now = Date.parse('2026-09-22T21:15:27.400Z');
  assert.equal(getCountdownText(now), getCountdownText(now));
  assert.equal(getCountdownText(now), '02:44:33');
});
