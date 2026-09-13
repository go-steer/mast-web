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

// 015-config-discovery — the SPA asks GET /config where the attach API
// is, instead of making the operator type it.
//
// The mock server answers /config for real, but only ever with
// `mode: "mock"`. The interesting shape is the hosted one — a BFF
// serving the API under --api-prefix — and standing a real one up is
// what dev/tools/e2e-real-backend is for. Here the descriptor is faked
// with page.route(), and requests under the advertised prefix are
// rewritten back onto the mock's own routes, so what is under test is
// the client's half: does it ask, does it believe the answer, does it
// stop asking the human.
//
// Half of this spec used to be about index.html's setup modal: whether
// discovery suppressed it, whether it hid the token box, what it said
// on a 401. #61 deleted that document, and the shells that survive have
// no modal to suppress — they have a sidebar with an attach form in it,
// which is always there and is not a question being asked. So the
// assertions moved to the two things the sidebar does with a
// descriptor: which endpoint it offers, and what it says when the
// origin will not answer.

import { test, expect } from '@playwright/test';

const PREFIX = '/attach';

const HOSTED = {
  mode: 'proxy',
  api_prefix: PREFIX,
  multi_daemon: false,
  backends: [],
  auth: { mode: 'iap-jwt', authenticated: true, identity: 'alice@example.com' },
};

/**
 * Serve a fake /config, and make the prefix it advertises real by
 * rewriting those requests onto the mock's unprefixed routes. Without
 * the rewrite the SPA would attach to a 404 and every assertion would
 * be about the failure path instead of the discovery.
 */
async function fakeDeployment(page, config, status = 200) {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch (_e) {
      /* blocked storage — discovery is what's under test anyway */
    }
  });
  await page.route('**/config', (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(config),
    })
  );
  await page.route(`**${PREFIX}/**`, (route) => {
    const url = new URL(route.request().url());
    url.pathname = url.pathname.slice(PREFIX.length);
    return route.continue({ url: url.toString() });
  });
}

test.describe('smoke: 015-config-discovery', () => {
  test('spatial shell lists the advertised prefix instead of guessing same-origin', async ({
    page,
  }) => {
    await fakeDeployment(page, HOSTED);
    await page.goto('/spatial.html');

    // A session row at all means GET /attach/sessions answered — the
    // same-origin guess this shell used to make would have been the one
    // address a BFF deployment does not serve.
    const row = page.locator('.side-session').first();
    await expect(row).toBeVisible();
    await expect(page.locator('.side-daemon-name')).toHaveAttribute('title', PREFIX);
    // And the attach form offers the path this deployment serves.
    await expect(page.locator('#add-endpoint')).toHaveValue(PREFIX);

    await row.click();
    await expect(page.locator('.panel-anchor.active .panel')).toHaveAttribute(
      'data-conn',
      'connected'
    );
  });

  test('solo shell does the same', async ({ page }) => {
    await fakeDeployment(page, HOSTED);
    await page.goto('/solo.html');

    const row = page.locator('.side-session').first();
    await expect(row).toBeVisible();
    await expect(page.locator('#add-endpoint')).toHaveValue(PREFIX);

    await row.click();
    await expect(page.locator('#solo-panel')).toHaveAttribute('data-conn', 'connected');
  });

  test('the discovered endpoint is not written back to storage', async ({ page }) => {
    await fakeDeployment(page, HOSTED);
    await page.goto('/solo.html');
    await expect(page.locator('.side-session').first()).toBeVisible();

    // Persisting it would outrank the next boot's discovery — in a key
    // both shells read, where a stale row has nothing left to repair it
    // now that the setup modal is gone.
    const stored = await page.evaluate(() => localStorage.getItem('mast-web:daemons'));
    expect(JSON.parse(stored || '[]')).toEqual([]);
  });

  test('static mode leaves the operator the same-origin row', async ({ page }) => {
    await fakeDeployment(page, {
      mode: 'static',
      api_prefix: '',
      auth: { mode: 'none', authenticated: true },
    });
    await page.goto('/solo.html');

    // static reports no prefix on purpose: there the operator picks the
    // backend, and the client overriding that would be inventing a
    // policy the server deliberately declined to state. So the attach
    // form keeps the markup's `/` and the sidebar tries it.
    await expect(page.locator('#add-endpoint')).toHaveValue('/');
    await expect(page.locator('.side-session').first()).toBeVisible();
  });

  test('a 401 reads as an expired session, not as a missing backend', async ({ page }) => {
    await fakeDeployment(
      page,
      { error: 'unauthenticated', message: 'no verified caller identity on this request' },
      401
    );
    await page.goto('/solo.html');

    // The document could not have been served at all without a fresh
    // sign-in, so reloading is the recovery — and saying so is the one
    // thing a row full of "unauthorized" cannot.
    await expect(page.locator('.side-error')).toContainText('expired');
    await expect(page.locator('.side-error')).toContainText('reload');
  });

  test('a deployment that does not describe itself behaves exactly as before', async ({ page }) => {
    await fakeDeployment(page, {}, 404);
    await page.goto('/solo.html');

    // A 404 here is a fine answer: it means nobody is describing this
    // deployment, and same-origin is the guess that was always made.
    await expect(page.locator('#add-endpoint')).toHaveValue('/');
    await page.locator('.side-session').first().click();
    await expect(page.locator('#solo-panel')).toHaveAttribute('data-conn', 'connected');
  });

  test('a stored daemon outranks whatever the origin advertises', async ({ page }) => {
    await fakeDeployment(page, HOSTED);
    await page.addInitScript(() => {
      localStorage.setItem(
        'mast-web:daemons',
        JSON.stringify([{ endpoint: '/', token: '', alias: 'same-origin', addedAt: '' }])
      );
    });
    await page.goto('/spatial.html');

    await expect(page.locator('.side-session').first()).toBeVisible();
    // Still the operator's row: the attach form was never re-pointed,
    // because discovery never ran.
    await expect(page.locator('#add-endpoint')).toHaveValue('/');
  });
});
