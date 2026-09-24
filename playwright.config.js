'use strict';
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/browser',
  timeout: 20_000,
  use: { headless: true },
  workers: 1,
  reporter: 'line',
});
