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

// Smoke: 024-stop — the STOP button, end to end.
//
// #68 and #73 were both about what STOP does, and until this file no
// smoke spec ever pressed it: `term-stop` appeared nowhere under
// smoke/. It could not have been pressed usefully — the mock answered a
// prompt with a wake and nothing else, and its interrupt handler sent no
// frame, so a turn the button cancelled never ended in the browser. The
// first person to run the manual walkthrough at a watchable speed found
// both, and then found that the cancel, once it did arrive, read as
// "Error: canceled: turn canceled".
//
// Turns are held open here (cmd/mast-web-server/mock_play.go): at the
// suite's 10ms pacing a played turn ends before a click could land.

import { test, expect } from '@playwright/test';
import { openSoloSession, resetTurnRequests, turnRequests } from './helpers.js';

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

const stopBtn = (page) => term(page).locator('.term-stop');
const sendBtn = (page) => term(page).locator('.term-send');
const prompt = (page) => term(page).locator('.term-prompt');

async function openTurns(page, open) {
  const res = open
    ? await page.request.post('/_mock/turns', { data: { open: true } })
    : await page.request.delete('/_mock/turns');
  expect(res.ok()).toBeTruthy();
}

async function send(page, text) {
  await prompt(page).fill(text);
  await prompt(page).press('Enter');
}

test.beforeEach(async ({ page }) => {
  await page.request.delete('/_mock/pause-gates');
  await openTurns(page, true);
});

test.afterEach(async ({ page }) => {
  await openTurns(page, false);
  await page.request.delete('/_mock/pause-gates');
});

test.describe('smoke: 024-stop', () => {
  test('STOP is there for the turn and only for the turn', async ({ page }) => {
    await openSettled(page);
    // Hidden, not disabled: between turns the composer offers SEND alone.
    await expect(stopBtn(page)).toBeHidden();

    await send(page, 'take your time');
    await expect(stopBtn(page)).toBeVisible();
    await expect(stopBtn(page)).toHaveText('STOP');
    await expect(sendBtn(page)).toBeDisabled();
  });

  test('STOP ends the turn, says so plainly, and does not park', async ({ page }) => {
    const screen = await openSettled(page);
    await send(page, 'take your time');
    await expect(stopBtn(page)).toBeVisible();

    await stopBtn(page).click();

    // The turn ends: the way back in is open again.
    await expect(stopBtn(page)).toBeHidden();
    await expect(sendBtn(page)).toBeEnabled();
    // In words that do not read as a fault. Somebody asked for this.
    await expect(screen.locator('.message.system').last()).toHaveText(/Turn canceled\./);
    await expect(screen).not.toContainText('Error: canceled');
    // And no hold: STOP sends hold:false, a cancel rather than a park
    // (#73). A banner here would be the #68 regression.
    await expect(term(page).locator('.term-hold')).toBeHidden();
  });

  test('the next prompt starts straight away', async ({ page }) => {
    await openSettled(page);
    await send(page, 'first');
    await stopBtn(page).click();
    await expect(sendBtn(page)).toBeEnabled();

    await resetTurnRequests(page);
    await send(page, 'second');
    await expect(stopBtn(page)).toBeVisible();
    // No gate to release first, so the prompt went out as a turn.
    expect(await turnRequests(page)).toEqual({ inject: 1 });
  });
});
