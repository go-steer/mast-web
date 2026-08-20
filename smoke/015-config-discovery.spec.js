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
  test('classic shell attaches to the advertised prefix without asking', async ({ page }) => {
    await fakeDeployment(page, HOSTED);
    await page.goto('/');

    await expect(page.locator('#status-connection')).toHaveClass(/\bconnected\b/);
    // The whole point: nobody had to type `/attach`.
    await expect(page.locator('#setup-modal')).not.toHaveClass(/open/);
    await expect(page.locator('#backend-info')).toHaveText(PREFIX);
    // The BFF named the caller on the first request the SPA made, well
    // before any backend could.
    await expect(page.locator('#identity-info')).toHaveText('alice@example.com');
  });

  test('the discovered endpoint is not written back to storage', async ({ page }) => {
    await fakeDeployment(page, HOSTED);
    await page.goto('/');
    await expect(page.locator('#status-connection')).toHaveClass(/\bconnected\b/);

    // Persisting it would outrank the next boot's discovery — in a key
    // the 3D shells read too, where a stale row has no setup modal to
    // repair it.
    const stored = await page.evaluate(() => localStorage.getItem('mast-web:daemons'));
    expect(JSON.parse(stored || '[]')).toEqual([]);
  });

  test('an authenticating deployment hides the token box', async ({ page }) => {
    await fakeDeployment(page, HOSTED);
    await page.goto('/');
    await expect(page.locator('#status-connection')).toHaveClass(/\bconnected\b/);

    // The proxy strips Authorization / X-Attach-Token off everything it
    // forwards, so a token typed here would be scrubbed in flight and
    // the failure would read as a bad credential.
    await expect(page.locator('#setup-token')).toBeHidden();
    await expect(page.locator('label[for="setup-token"]')).toBeHidden();
  });

  test('static mode still asks — the operator picks the backend there', async ({ page }) => {
    await fakeDeployment(page, {
      mode: 'static',
      api_prefix: '',
      auth: { mode: 'none', authenticated: true },
    });
    await page.goto('/');

    await expect(page.locator('#setup-modal')).toHaveClass(/open/);
    await expect(page.locator('#setup-token')).toBeVisible();
  });

  test('a 401 reads as an expired session, not as a missing backend', async ({ page }) => {
    await fakeDeployment(
      page,
      { error: 'unauthenticated', message: 'no verified caller identity on this request' },
      401
    );
    await page.goto('/');

    await expect(
      page.locator('#output-area .message.system', { hasText: 'session with this server' })
    ).toBeVisible();
    await expect(page.locator('#output-area .message.system').first()).toContainText('Reload');
    // Nothing to attach to, so the modal is still the fallback.
    await expect(page.locator('#setup-modal')).toHaveClass(/open/);
  });

  test('a deployment that does not describe itself behaves exactly as before', async ({ page }) => {
    await fakeDeployment(page, {}, 404);
    await page.goto('/');

    await expect(page.locator('#setup-modal')).toHaveClass(/open/);
    await expect(page.locator('#setup-endpoint')).toHaveValue('/');
    await page.click('#setup-save');
    await expect(page.locator('#status-connection')).toHaveClass(/\bconnected\b/);
  });

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
