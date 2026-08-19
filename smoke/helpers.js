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
 * The spatial shell's equivalent of connectToMock: load spatial.html,
 * open the mock's session into a 3D terminal, and hand back a locator
 * for that terminal's transcript.
 *
 * There is no setup modal here — spatial.js defaults an unconfigured
 * registry to same-origin `/` (loadDaemons), which is what the mock
 * serves on. So the whole dance is: clear storage, load, click the one
 * session row. Storage is cleared before first paint rather than after,
 * because a saved workspace would restore panels we didn't ask for.
 *
 * Returns the `.term-screen` locator, not the panel: asserting on the
 * panel would also match the title bar and status line, and a stray
 * match there would be a false pass.
 */
export async function openSpatialSession(page, fixture) {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch (_e) {
      /* blocked storage — spatial.js falls back to same-origin anyway */
    }
  });
  const url = fixture ? `/spatial.html?fixture=${encodeURIComponent(fixture)}` : '/spatial.html';
  await page.goto(url);

  const row = page.locator('.side-session').first();
  await expect(row).toBeVisible();
  await row.click();

  const panel = page.locator('.panel-anchor.active .panel');
  await expect(panel).toHaveAttribute('data-conn', 'connected');
  return panel.locator('.term-screen');
}

/**
 * Clear the mock's tally of /inject and /wake posts, so a subsequent
 * read reflects one prompt rather than everything since boot
 * (connecting posts nothing today, but that is not a guarantee worth
 * depending on).
 */
export async function resetTurnRequests(page) {
  const res = await page.request.delete('/_mock/turn-requests');
  expect(res.ok()).toBeTruthy();
}

/**
 * Read the mock's tally of /inject and /wake posts as a plain object.
 * Endpoints with no posts are absent rather than zero, so an equality
 * assertion catches an unexpected extra write.
 *
 * Settles first. The assertion this feeds is partly a negative — "no
 * /wake was posted" — and a stray write chained onto the inject lands
 * a few ms later, so reading eagerly can sample between the two and
 * call the bug green. (It did: the spatial half of 008 passed against
 * a deliberately reverted fix until this wait existed.) Poll until the
 * tally stops moving rather than guessing a single sleep.
 */
export async function turnRequests(page) {
  let prev = null;
  for (let i = 0; i < 12; i++) {
    const res = await page.request.get('/_mock/turn-requests');
    expect(res.ok()).toBeTruthy();
    const now = JSON.stringify(await res.json());
    if (prev !== null && now === prev) return JSON.parse(now);
    prev = now;
    await page.waitForTimeout(150);
  }
  return JSON.parse(prev);
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
