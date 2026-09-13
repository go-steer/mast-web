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

// Smoke: 018-shell-entry — what `/` does now that index.html is not a
// console (#61).
//
// The precedence table is v0.4 plan §1, and it is deliberately split
// across two documents: web/shell-select.js reads it on the way in, and
// web/shell.js writes the stored half from inside a shell — via the HUD
// link and via /shell. Neither half is checkable from the other, and
// the interesting failures are all navigational: a loop between `/` and
// a shell, a deep link that re-homes the person you sent it to, a
// preference that is written but never read. Those need a browser.

import { test, expect } from '@playwright/test';

const KEY = 'mast-web:shell';
const stored = (page) => page.evaluate((k) => localStorage.getItem(k), KEY);

test.describe('smoke: 018-shell-entry', () => {
  test('`/` lands on solo with nothing stored', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/solo\.html$/);
    await expect(page.locator('#solo-empty')).toBeVisible();
  });

  // replace(), not assign(): a chooser left in history is a back button
  // that bounces straight forward again.
  //
  // Needs a real page ahead of `/` for back to have anywhere to go —
  // every context starts on a blank tab, and landing there would pass
  // this test for the wrong reason.
  test('the chooser leaves no history entry to go back to', async ({ page }) => {
    await page.goto('/spatial.html');
    await page.goto('/');
    await expect(page).toHaveURL(/\/solo\.html$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/spatial\.html$/);
  });

  test('?shell= wins, and does not re-home the person who followed it', async ({ page }) => {
    await page.goto('/?shell=spatial');
    await expect(page).toHaveURL(/\/spatial\.html$/);
    await expect(page.locator('#app-hud')).toBeVisible();

    // Sending someone a link to the room is not a decision about where
    // they work. Nothing was written, so `/` still means solo.
    expect(await stored(page)).toBeNull();
    await page.goto('/');
    await expect(page).toHaveURL(/\/solo\.html$/);
  });

  // The rest of the query string belongs to the shell — ?fixture= in
  // particular, which every other spec in this suite hands to the mock
  // through it.
  test('the rest of the query string rides along', async ({ page }) => {
    await page.goto('/?shell=solo&fixture=001-happy-turn');
    await expect(page).toHaveURL(/\/solo\.html\?fixture=001-happy-turn$/);

    await page.locator('.side-session').first().click();
    await expect(page.locator('#solo-body .term:visible .message.assistant')).toContainText(
      'Hello world'
    );
  });

  test('the HUD link is what makes the trip stick', async ({ page }) => {
    await page.goto('/solo.html');
    // data-shell, not the id: the attribute is what shell.js binds to,
    // and an href that lost it would still navigate.
    await page.locator('[data-shell="spatial"]').click();
    await expect(page).toHaveURL(/\/spatial\.html$/);
    expect(await stored(page)).toBe('spatial');

    // …and that is the preference `/` reads on the next visit.
    await page.goto('/');
    await expect(page).toHaveURL(/\/spatial\.html$/);

    // The link back does the same in reverse, so the preference is not
    // a one-way door.
    await page.locator('[data-shell="solo"]').click();
    await expect(page).toHaveURL(/\/solo\.html$/);
    expect(await stored(page)).toBe('solo');
  });

  test('/shell records the preference and goes there', async ({ page }) => {
    await page.goto('/solo.html?fixture=001-happy-turn');
    await page.locator('.side-session').first().click();
    const input = page.locator('#solo-body .term:visible .term-prompt');

    // Listing first: the current shell is marked, and the command says
    // which one `/` is currently pointed at — a preference you cannot
    // read is a preference you cannot trust.
    await input.fill('/shell');
    await input.press('Enter');
    const out = page.locator('#solo-body .term:visible .message.system').last();
    await expect(out).toContainText('Shells');
    await expect(out).toContainText('Stored preference: solo');

    await input.fill('/shell spatial');
    await input.press('Enter');
    await expect(page).toHaveURL(/\/spatial\.html$/);
    expect(await stored(page)).toBe('spatial');
  });

  // Scripting off, or shell-select.js failing to load. Both shells work
  // when reached directly, so the honest fallback is to say so rather
  // than to fail blank.
  test.describe('without scripting', () => {
    test.use({ javaScriptEnabled: false });

    test('the doormat names both shells', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('a[href="solo.html"]')).toBeVisible();
      await expect(page.locator('a[href="spatial.html"]')).toBeVisible();
    });
  });
});
