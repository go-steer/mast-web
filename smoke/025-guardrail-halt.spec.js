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

// Smoke: 025-guardrail-halt — what a halted session looks like (v0.6).
//
// Protocol 1.13.0 (core-agent#891) moved a guardrail trip out of
// `turn-error` and onto its own `guardrail-trip` frame. mast-web v0.5.0
// drops that frame, so against a current daemon a halt is invisible. And
// since core-agent#1040 an inject into a halted session is queued and
// runs NOTHING until a reset: no wake, no turn, no frame. The composer
// waits for a turn end that never comes. That is v0.6 plan §2.
//
// v0.6 PR 0 (#110) landed the two cases marked (#111) below as
// test.fail(): they failed against v0.5.0's browser, and the dead end was
// watched before it was fixed. PR 1 (#111) is what makes them pass.
//
// Turns are played (the default) unless a case needs one held open.

import { test, expect } from '@playwright/test';
import { openSoloSession, resetTurnRequests, turnRequests } from './helpers.js';

const SID = 'smoke-session';
const term = (page) => page.locator('#solo-body .term:visible');

// The mock replays its fixture when the stream opens, as live frames,
// and the default fixture is a whole turn that ends in a turn-complete.
// A prompt sent while that replay is still draining has its turn closed
// by the REPLAY's turn-complete — STOP vanishes mid-test. On a fast
// machine the replay always wins the race; on CI's runner it lost
// (PR #128's first run, both attempts), and the screenshot showed the
// replay's footer stamped under the test's own prompt. Wait for the
// replayed turn to land, as a person would, before sending anything.
async function openSettled(page) {
  const screen = await openSoloSession(page);
  await expect(screen.locator('.turn-footer')).toHaveCount(1);
  return screen;
}

async function trip(page, body) {
  const res = await page.request.post('/_mock/guardrail-trip', { data: { session: SID, ...body } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test.beforeEach(async ({ page }) => {
  await page.request.delete('/_mock/guardrails');
  await page.request.delete('/_mock/pause-gates');
});

test.afterEach(async ({ page }) => {
  await page.request.delete('/_mock/guardrails');
  await page.request.delete('/_mock/pause-gates');
});

test.describe('smoke: 025-guardrail-halt', () => {
  // The server side, which is true today and must stay true: a halted
  // session accepts the prompt and runs nothing.
  test('the mock queues a prompt sent to a halted session and runs nothing', async ({ page }) => {
    await openSettled(page);
    await trip(page, { guardrail: 'watchdog', halted_turn: false });
    await resetTurnRequests(page);

    const prompt = term(page).locator('.term-prompt');
    await prompt.fill('are you still there?');
    await prompt.press('Enter');

    await expect.poll(() => turnRequests(page)).toEqual({ inject: 1 });
    const status = await (await page.request.get(`/sessions/${SID}/status`)).json();
    expect(status.turn_in_flight).toBe(false);
    const g = await (await page.request.get(`/sessions/${SID}/guardrails`)).json();
    expect(g.halted).toBe(true);
  });

  // THE DEAD END. Typing at a halted session must not leave the composer
  // waiting forever. Fixed by #111.
  test('typing at a halted session gives the composer back and says why (#111)', async ({
    page,
  }) => {
    await openSettled(page);
    await trip(page, { guardrail: 'watchdog', halted_turn: false });

    const prompt = term(page).locator('.term-prompt');
    await prompt.fill('are you still there?');
    await prompt.press('Enter');

    // Generous on purpose: the failure is "never", not "slowly".
    await expect(term(page).locator('.term-send')).toBeEnabled({ timeout: 5000 });
    await expect(term(page).locator('.term-stop')).toBeHidden();
    await expect(term(page)).toContainText('queued', { timeout: 1000 });
  });

  // The halt's explanation. v0.5.0 drops the frame that carries it.
  // Fixed by #111.
  test("a guardrail trip says why, in the producer's words (#111)", async ({ page }) => {
    await openSettled(page);
    await trip(page, { guardrail: 'watchdog', halted_turn: false });
    await expect(term(page)).toContainText('/guardrail reset watchdog', { timeout: 3000 });
  });

  // A trip that cuts a turn ends it with a `canceled` that says nothing
  // the trip didn't. The trip absorbs it: one explanation, not a
  // meaningful block with a contentless warning under it (spec §2.10).
  test('a trip that cuts a turn absorbs the cancel it causes', async ({ page }) => {
    const open = await page.request.post('/_mock/turns', { data: { open: true } });
    expect(open.ok()).toBeTruthy();
    try {
      await openSettled(page);
      const prompt = term(page).locator('.term-prompt');
      await prompt.fill('summarise all forty incident reports');
      await prompt.press('Enter');
      await expect(term(page).locator('.term-stop')).toBeVisible();

      await trip(page, {});

      await expect(term(page).locator('.guardrail-trip')).toContainText('the turn was cut');
      await expect(term(page).locator('.term-send')).toBeEnabled();
      await expect(term(page).locator('.term-stop')).toBeHidden();
      await expect(term(page)).not.toContainText('Turn canceled.');
    } finally {
      await page.request.delete('/_mock/turns');
    }
  });

  // core-agent#1049: a per-turn cost trip ends one turn and leaves the
  // session running. The trip is still worth showing — the spend is news
  // — but nothing may claim the session is halted.
  test('a per-turn trip is shown, and the session is not called halted', async ({ page }) => {
    await openSettled(page);
    await trip(page, { halts_session: false, halted_turn: false });
    await expect(term(page).locator('.guardrail-trip')).toContainText('NOT halted');
    await expect(term(page).locator('.term-halt')).toBeHidden();
    await expect(page.locator('#status-fleet')).not.toContainText('halted');
  });

  // The halt is session state, so it has a banner over the prompt and a
  // count in the window — the same pair the hold got (#70 OQ2), and for
  // the same reason: a halted session behind another tab is invisible.
  test('a halt draws a banner and a window count, from GET /guardrails', async ({ page }) => {
    await openSettled(page);
    await trip(page, { guardrail: 'watchdog', halted_turn: false });
    const banner = term(page).locator('.term-halt');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('HALTED — watchdog');
    await expect(banner).toContainText('/guardrail reset watchdog');
    await expect(page.locator('#status-fleet')).toContainText('1 halted');
    await expect(term(page).locator('.term-prompt')).toHaveAttribute('placeholder', /halted/);
  });

  // The way out: a reset clears the halt, the banner comes down because
  // the server said so, and the message queued while halted runs.
  test('a reset takes the banner down and runs what was queued', async ({ page }) => {
    const screen = await openSettled(page);
    await trip(page, { guardrail: 'watchdog', halted_turn: false });
    await expect(term(page).locator('.term-halt')).toBeVisible();

    const prompt = term(page).locator('.term-prompt');
    await prompt.fill('carry on once you can');
    await prompt.press('Enter');
    await expect(term(page)).toContainText('queued');

    await prompt.fill('/guardrail reset watchdog');
    await prompt.press('Enter');

    await expect(term(page).locator('.term-halt')).toBeHidden();
    await expect(page.locator('#status-fleet')).not.toContainText('halted');
    // The queued message drained as the first turn after the reset: a
    // second reply lands under the replay's.
    await expect(screen.locator('.turn-footer')).toHaveCount(2);
  });
});
