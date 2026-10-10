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

// Smoke: 028-subagents-bar — what's running in the background (v0.7 #139).
//
// core-tui has shown running subagents in a bar over its prompt for
// months; mast-web couldn't, because nothing read the live roster
// (GET /sessions/{sid}/agents). v0.7 PR 0 (#138) put the roster on the
// status chain and gave the mock subagents on demand (POST
// /_mock/subagent); this is the bar that draws it, in both shells, with
// the count in the window's status bar.
//
// Subagents are made BEFORE the session opens where the case allows: the
// attach-time read picks them up at once, where one made later waits up
// to 10 s for the idle poll.

import { test, expect } from '@playwright/test';
import { openSoloSession, openSpatialSession } from './helpers.js';

const SID = 'smoke-session';

async function subagent(page, body) {
  const res = await page.request.post('/_mock/subagent', { data: { session: SID, ...body } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test.beforeEach(async ({ page }) => {
  await page.request.delete('/_mock/subagents');
});

test.afterEach(async ({ page }) => {
  await page.request.delete('/_mock/subagents');
});

test.describe('smoke: 028-subagents-bar', () => {
  test('no subagents, no bar', async ({ page }) => {
    await openSoloSession(page);
    await expect(page.locator('#solo-body .term:visible .term-agents')).toBeHidden();
    await expect(page.locator('#status-fleet')).not.toContainText('subagent');
  });

  test('a running subagent: its row, the count, and how it ended', async ({ page }) => {
    await subagent(page, {
      name: 'researcher',
      started_ago_s: 125,
      last_report: 'reading pkg/attach\nand the rest',
    });
    await openSoloSession(page);
    const bar = page.locator('#solo-body .term:visible .term-agents');
    const row = bar.locator('.term-agent').first();
    await expect(row).toBeVisible();
    await expect(row.locator('.term-agent-name')).toHaveText('researcher');
    await expect(row.locator('.term-agent-state')).toHaveText(/^2m0\ds$/);
    await expect(row.locator('.term-agent-report')).toHaveText('reading pkg/attach');
    await expect(page.locator('#status-fleet')).toContainText('1 subagent running');

    // It finishes. A running subagent puts the chain on its 3 s rate, so
    // the bar sees it within one tick and keeps the row for five seconds
    // with the outcome; the count drops at once.
    await subagent(page, { name: 'researcher', status: 'failed', last_report: 'quota exceeded' });
    await expect(row).toHaveAttribute('data-status', 'failed', { timeout: 6000 });
    await expect(row.locator('.term-agent-state')).toHaveText('failed');
    await expect(page.locator('#status-fleet')).not.toContainText('subagent');
    await expect(bar).toBeHidden({ timeout: 8000 });
  });

  test('a sleeping subagent counts down to its wake', async ({ page }) => {
    await subagent(page, {
      name: 'watcher',
      started_ago_s: 900,
      last_report: 'checked the build',
      wake_in_s: 240,
      wake_detail: 'poll the build again',
    });
    await openSoloSession(page);
    const row = page.locator('#solo-body .term:visible .term-agents .term-agent').first();
    await expect(row.locator('.term-agent-state')).toHaveText(/^wakes in 3m5\ds$/);
    await expect(row.locator('.term-agent-report')).toHaveText('poll the build again');
    await expect(page.locator('#status-fleet')).toContainText('1 subagent scheduled');
  });

  test('four subagents: three rows, the last pointing at /subagents', async ({ page }) => {
    for (const [name, ago] of [
      ['a', 40],
      ['b', 30],
      ['c', 20],
      ['d', 10],
    ]) {
      await subagent(page, { name, started_ago_s: ago });
    }
    await openSoloSession(page);
    const rows = page.locator('#solo-body .term:visible .term-agents .term-agent');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toHaveText('+ 2 more · /subagents');
    await expect(page.locator('#status-fleet')).toContainText('4 subagents running');
  });

  // Plan OQ 2: the panel in front gets the bar; a parked one gets one row.
  test('spatial: the panel in front draws the bar, a parked one keeps a row', async ({ page }) => {
    await subagent(page, { name: 'a', started_ago_s: 20 });
    await subagent(page, { name: 'b', started_ago_s: 10 });
    await openSpatialSession(page, '001-happy-turn');
    const panel = page.locator('.panel-anchor.active');
    await expect(panel.locator('.term-agents .term-agent')).toHaveCount(2);
    await expect(panel.locator('.term-subagents')).toHaveText('2 subagents running');

    await page.keyboard.press('Escape');
    const parked = page.locator('.panel-anchor').first();
    await expect(page.locator('.panel-anchor.active')).toHaveCount(0);
    await expect(parked.locator('.term-agents .term-agent')).toHaveText([
      '2 subagents · /subagents',
    ]);
  });
});
