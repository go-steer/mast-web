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
// These cases assert what SHOULD happen and are marked test.fail():
// v0.6 PR 0 (#110) is the wire and the mock only, so today they fail,
// and Playwright expects them to. When PR 1 (#111) makes them pass,
// Playwright reports the unexpected pass as an error, and the marker has
// to come off — the bug cannot be fixed by accident and forgotten.
//
// Turns are played (the default): the mock's halt is what stops them.

import { test, expect } from '@playwright/test';
import { openSoloSession, resetTurnRequests, turnRequests } from './helpers.js';

const SID = 'smoke-session';
const term = (page) => page.locator('#solo-body .term:visible');

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
    await openSoloSession(page);
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
  test.fail(
    'typing at a halted session gives the composer back and says why (#111)',
    async ({ page }) => {
      await openSoloSession(page);
      await trip(page, { guardrail: 'watchdog', halted_turn: false });

      const prompt = term(page).locator('.term-prompt');
      await prompt.fill('are you still there?');
      await prompt.press('Enter');

      // Generous on purpose: the failure is "never", not "slowly".
      await expect(term(page).locator('.term-send')).toBeEnabled({ timeout: 5000 });
      await expect(term(page).locator('.term-stop')).toBeHidden();
      await expect(term(page)).toContainText('queued', { timeout: 1000 });
    }
  );

  // The halt's explanation. v0.5.0 drops the frame that carries it.
  // Fixed by #111.
  test.fail("a guardrail trip says why, in the producer's words (#111)", async ({ page }) => {
    await openSoloSession(page);
    await trip(page, { guardrail: 'watchdog', halted_turn: false });
    await expect(term(page)).toContainText('/guardrail reset watchdog', { timeout: 3000 });
  });
});
