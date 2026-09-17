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

// Smoke: 020-operator-hold — the pause gate, from the browser (#70).
//
// The claim this file exists for is the one #90 could not make: since
// protocol v1.11.0 (core-agent#878) an inject no longer releases a
// hold, so a session parked by anyone — another tab, an embedded TUI,
// a scheduler, a cost ceiling — stays parked until somebody resumes
// it. Before this PR there was no resume control in either shell, so
// "typing does not rescue a held session" was true and also a dead
// end: the only way out of a gate was to close the browser.
//
// The assertion with teeth is the turn tally. Typing at a held session
// has to reach /resume and NOT /inject — an inject would queue behind
// the gate forever, and the mock counts posts precisely so a spec can
// tell those two apart when the rendered transcript cannot.
//
// The gate is the mock's only persistent state, so every case clears
// it first: a spec that leaves a session held is a spec that breaks
// the next one.

import { test, expect } from '@playwright/test';
import { openSoloSession, resetTurnRequests, turnRequests } from './helpers.js';

const prompt = (page) => page.locator('#solo-body .term:visible .term-prompt');
const banner = (page) => page.locator('#solo-body .term:visible .term-hold');

async function run(page, command) {
  const input = prompt(page);
  await input.fill(command);
  await input.press('Enter');
}

test.beforeEach(async ({ page }) => {
  const res = await page.request.delete('/_mock/pause-gates');
  expect(res.ok()).toBeTruthy();
});

test.describe('smoke: 020-operator-hold', () => {
  test('/pause raises a banner that says why, and how to get out', async ({ page }) => {
    await openSoloSession(page);
    await expect(banner(page)).toBeHidden();

    await run(page, '/pause looking at the diff');

    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText('HELD — looking at the diff');
    // The two facts, in the order an operator asks for them: was my
    // work killed, and does anything still have to be released.
    await expect(banner(page)).toContainText('Nothing was in flight.');
    await expect(banner(page)).toContainText('No new turn starts until this is released.');
    await expect(banner(page).getByRole('button', { name: 'CONTINUE' })).toBeVisible();
    await expect(banner(page).getByRole('button', { name: 'ABANDON' })).toBeVisible();

    // And the window says it too, because the banner is in a panel that
    // may well be behind a tab nobody is looking at.
    await expect(page.locator('#status-fleet')).toContainText('1 held');
    // The prompt still takes text, and now says what it will do with it.
    await expect(prompt(page)).toHaveAttribute('placeholder', /steer/);
  });

  // The #90 assertion, finally makeable: the gate is not something a
  // typed message walks through.
  test('typing at a held session steers it rather than queueing behind it', async ({ page }) => {
    const screen = await openSoloSession(page);
    await run(page, '/pause');
    await expect(banner(page)).toBeVisible();

    await resetTurnRequests(page);
    await run(page, 'use the other file');

    // The operator's own line is in the transcript...
    await expect(screen.locator('.message.user').last()).toContainText('use the other file');
    // ...and it went to /resume. An /inject here is the pre-1.11.0
    // assumption in disguise: it would sit in the inbox behind a gate
    // that nothing in this session is going to open.
    expect(await turnRequests(page)).toEqual({});
    await expect(screen.locator('.message.system').last()).toContainText(
      'the correction goes in first'
    );
    // The steer released the gate, so the banner is down and the window
    // count with it.
    await expect(banner(page)).toBeHidden();
    await expect(page.locator('#status-fleet')).not.toContainText('held');
  });

  test('a slash command at a held session is still a command', async ({ page }) => {
    const screen = await openSoloSession(page);
    await run(page, '/pause');
    await expect(banner(page)).toBeVisible();

    await resetTurnRequests(page);
    await run(page, '/help');

    await expect(screen.locator('.message.system').last()).toContainText('This list');
    // Not steered, not injected, and the gate is exactly where it was.
    expect(await turnRequests(page)).toEqual({});
    await expect(banner(page)).toBeVisible();
  });

  test('/continue releases the hold and narrates the disposition', async ({ page }) => {
    const screen = await openSoloSession(page);
    await run(page, '/pause');
    await expect(banner(page)).toBeVisible();

    await run(page, '/continue');

    await expect(banner(page)).toBeHidden();
    await expect(screen.locator('.message.system').last()).toContainText(
      'carrying on from where it stopped'
    );
  });

  test('the ABANDON button is the same gesture as the command', async ({ page }) => {
    const screen = await openSoloSession(page);
    await run(page, '/pause');
    await banner(page).getByRole('button', { name: 'ABANDON' }).click();

    await expect(banner(page)).toBeHidden();
    await expect(screen.locator('.message.system').last()).toContainText(
      'the held work was dropped'
    );
  });

  // One park, one line. The `pause` frame and the status poll carry the
  // same fact about a second apart, and an operator who reads "Session
  // held" twice reasonably concludes it happened twice.
  test('a hold set from somewhere else is announced exactly once', async ({ page }) => {
    const screen = await openSoloSession(page);
    // Not through the UI: this is the other-tab / scheduler / cost-
    // ceiling case, which is the one the banner exists for.
    const res = await page.request.post('/sessions/smoke-session/pause', {
      data: { reason: 'cost ceiling' },
    });
    expect(res.ok()).toBeTruthy();

    await expect(banner(page)).toContainText('HELD — cost ceiling');
    await expect(screen.locator('.message.system', { hasText: 'Session held' })).toHaveCount(1);
    await expect(screen.locator('.message.system').last()).toContainText(
      'Session held — cost ceiling'
    );
  });

  // The mid-turn half of the rule is a unit test (terminal.test.js):
  // this fixture streams and closes too fast to type into. What a
  // browser can still say is that the three names reach the table at
  // all, and that the alias is one command rather than two rows.
  test('lists all three hold commands, alias and all', async ({ page }) => {
    await openSoloSession(page);
    await run(page, '/help');
    const help = page.locator('#solo-body .term:visible .message.system').last();
    for (const name of ['/pause', '/continue', '/abandon']) {
      await expect(help).toContainText(name);
    }
    await expect(help).toContainText('alias /cont');
  });
});
