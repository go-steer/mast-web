// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Shared helpers for the Playwright smoke tests.
//
// Every scenario follows the same shape: load the SPA (optionally
// with ?fixture=), complete the setup modal, wait for the fixture
// to stream through, assert on DOM. Factoring that boilerplate here
// keeps the individual scenario files short + focused on what makes
// each fixture distinctive.

import { expect } from '@playwright/test';

/**
 * Load the SPA + go through the first-run setup modal to connect
 * to the same-origin mock backend. Optionally selects a fixture
 * via ?fixture=<name> — the SPA forwards this query param to the
 * mock's /events endpoint (see attach-core/client.js).
 *
 * Clears localStorage first so each test starts from a clean setup
 * modal instead of auto-connecting from a prior test's saved config.
 */
export async function connectToMock(page, fixture) {
  // Load the SPA. Query param forwards to mock's ?fixture= handler.
  const url = fixture ? `/?fixture=${encodeURIComponent(fixture)}` : '/';
  await page.goto(url);

  // Nuke saved config so the setup modal always opens fresh.
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch (_e) {
      /* ignore — non-critical */
    }
  });
  // Reload so the SPA sees the clean localStorage and reopens the
  // setup modal (it auto-connects if config is present).
  await page.reload();
  // Preserve the query param across the reload since it lives in the
  // URL bar rather than storage.
  if (fixture && !page.url().includes('fixture=')) {
    await page.goto(url);
  }

  // Wait for the setup modal to be visible + fill it. `/` = same
  // origin, no CORS. Token blank.
  const modal = page.locator('#setup-modal');
  await expect(modal).toBeVisible();
  await page.fill('#setup-endpoint', '/');
  await page.fill('#setup-token', '');
  await page.click('#setup-save');

  // Wait for the SPA to actually connect — status bar goes green,
  // sidebar populates with the mock's smoke-session.
  await expect(page.locator('#status-connection')).toHaveClass(/connected/);
}

/**
 * Wait for a system-message row containing the given substring to
 * appear in the transcript. Times out at Playwright's default (5s).
 */
export async function waitForSystemMessage(page, substring) {
  const row = page
    .locator('#output-area .message.system', { hasText: substring })
    .first();
  await expect(row).toBeVisible();
}
