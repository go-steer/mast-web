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
// Every scenario follows the same shape: load a shell (optionally with
// ?fixture=), open the mock's session into a terminal, wait for the
// fixture to stream through, assert on DOM. Factoring that boilerplate
// here keeps the individual scenario files short + focused on what
// makes each fixture distinctive.
//
// There were three of these openers until #61. The third —
// connectToMock — drove index.html's setup modal, and went with the
// document. Neither surviving shell asks: boot() discovers the
// endpoint, and a sidebar row is the gesture.

import { expect } from '@playwright/test';

/**
 * The spatial shell's equivalent of connectToMock: load spatial.html,
 * open the mock's session into a 3D terminal, and hand back a locator
 * for that terminal's transcript.
 *
 * There is no setup modal here — with nothing stored, the sidebar's boot()
 * asks GET /config where the API is, and the mock answers `mock` mode
 * with no prefix, so the registry falls back to the same-origin `/` the
 * mock serves on. So the whole dance is: clear storage, load, click the
 * one session row. Storage is cleared before first paint rather than
 * after, because a saved workspace would restore panels we didn't ask
 * for.
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
 * The solo shell's equivalent of openSpatialSession: load solo.html,
 * open the mock's first session into a tab, and hand back a locator for
 * that tab's transcript.
 *
 * Same registry defaulting as the spatial shell (discovery finds no
 * prefix in mock mode, so boot() falls back to same-origin `/`), so
 * there is no setup modal here either. Storage is cleared before first
 * paint because a saved tab layout would restore sessions we didn't ask
 * for.
 *
 * Returns the *visible* .term-screen rather than a panel-scoped one:
 * this shell keeps every open session mounted, so a panel-scoped
 * locator would match background transcripts too and a stray hit there
 * would be a false pass.
 */
export async function openSoloSession(page, fixture) {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch (_e) {
      /* blocked storage — solo.js falls back to same-origin anyway */
    }
  });
  const url = fixture ? `/solo.html?fixture=${encodeURIComponent(fixture)}` : '/solo.html';
  await page.goto(url);

  const row = page.locator('.side-session').first();
  await expect(row).toBeVisible();
  await row.click();

  await expect(page.locator('#solo-panel')).toHaveAttribute('data-conn', 'connected');
  return page.locator('#solo-body .term:visible .term-screen');
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
