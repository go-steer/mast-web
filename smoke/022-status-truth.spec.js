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

// Smoke: 022-status-truth — is this agent working? (#93, v1.12.0.)
//
// Until protocol 1.12.0 the browser could only answer "did I press
// send". `state: "running"` was declared from the start and never
// produced — the sole StatusProvider had no run-loop signal to read, so
// a mid-turn GET /status answered `idle` — and `turn_in_flight` did not
// exist. A session another operator, an embedded TUI or a scheduler was
// driving therefore looked idle in every surface this SPA draws.
//
// Every turn here is started from outside the browser on purpose. That
// is the whole case: a turn this page dispatched is already visible in
// the elapsed timer, and it was never the one being got wrong.
//
// The gate is the mock's only persistent state and these cases
// deliberately leave a turn running in it, so they clear it at both
// ends rather than only at the start.

import { test, expect } from '@playwright/test';
import { openSoloSession } from './helpers.js';

const SID = 'smoke-session';

const inflight = (page) => page.locator('#solo-body .term:visible .term-inflight');
const banner = (page) => page.locator('#solo-body .term:visible .term-hold');
const fleet = (page) => page.locator('#status-fleet');

// Somebody else starts a turn. An inject with a wake is what the mock
// models a run loop with: gate open, so the loop actually runs and
// turn_in_flight goes true until something stops it.
async function somebodyElseStartsATurn(page) {
  const res = await page.request.post(`/sessions/${SID}/inject`, {
    data: { message: 'draft the release notes', wake: true },
  });
  expect(res.ok()).toBeTruthy();
}

async function clearGates(page) {
  const res = await page.request.delete('/_mock/pause-gates');
  expect(res.ok()).toBeTruthy();
}

test.beforeEach(async ({ page }) => {
  await clearGates(page);
});

test.afterEach(async ({ page }) => {
  await clearGates(page);
});

test.describe('smoke: 022-status-truth', () => {
  // The attach-time read. No frame says this: the stream's seed
  // status-update is a snapshot of the model and the gate, and a turn
  // that started a minute before you opened the tab announced itself to
  // whoever was listening then. So the panel asks, once, on connect.
  test('a session somebody else is driving does not open looking idle', async ({ page }) => {
    await somebodyElseStartsATurn(page);
    await openSoloSession(page);

    await expect(inflight(page)).toBeVisible();
    await expect(inflight(page)).toHaveText('⟳ turn in flight');
    // And the window, which is where you look when the panel is behind
    // a tab you haven't clicked.
    await expect(fleet(page)).toContainText('1 running');
  });

  // The pair, and the reason upstream kept it a pair: `state` has one
  // slot and pause outranks running in it, so a session parked mid-turn
  // reports "paused" and the bool beside it is the only thing that can
  // say the turn the park interrupted is still going.
  test('held, and the turn it interrupted is still unwinding', async ({ page }) => {
    await somebodyElseStartsATurn(page);
    await openSoloSession(page);
    await expect(inflight(page)).toBeVisible();

    // The safe Stop's other half: cancel the turn AND park the loop.
    const res = await page.request.post(`/sessions/${SID}/interrupt`, { data: {} });
    expect(res.ok()).toBeTruthy();

    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText('The turn it interrupted is still unwinding.');
    // Both counts, because they are not the same set. A held session
    // with nothing running is a session waiting for you; a held session
    // with a turn behind the gate is still spending money.
    await expect(fleet(page)).toContainText('1 running');
    await expect(fleet(page)).toContainText('1 held');
  });

  // The standing poll rather than the attach-time read: the turn starts
  // while the tab is already open and nothing pushes the fact. Slower
  // than the rest of the suite by design — ten seconds between reads is
  // the idle cadence, and the point of the case is that the second read
  // happens at all.
  test('picks up a turn that starts after you are already watching', async ({ page }) => {
    test.setTimeout(60_000);
    await openSoloSession(page);
    await expect(inflight(page)).toBeHidden();

    await somebodyElseStartsATurn(page);
    await expect(inflight(page)).toBeVisible({ timeout: 20_000 });
    await expect(fleet(page)).toContainText('1 running', { timeout: 20_000 });

    // And it goes away again. The cadence is faster while something is
    // running, so this half does not need the long wait.
    await clearGates(page);
    await expect(inflight(page)).toBeHidden({ timeout: 20_000 });
    await expect(fleet(page)).not.toContainText('running');
  });
});
