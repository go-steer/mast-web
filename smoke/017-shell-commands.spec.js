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

// Smoke: 017-shell-commands — the window-level half of the capability
// port (#60, PR 3b): shell.js's overlays and commands, and the
// sidebar's session delete.
//
// 016 covers the commands that act on a session. These act on the page
// around it, and almost all of what could break about them is invisible
// to a unit test:
//
//   1. The overlays are built in JS and styled by CSS that was written
//      for index.html's markup. web/shell.test.js can assert the DOM is
//      there; only a browser can say whether it is on screen. The batch
//      drawer is the sharp case — styles.css gives #batch-panel a
//      `border-top` and expects the classic shell's document flow,
//      which these shells do not have, so it needs a rule of its own in
//      chrome.css and would otherwise render in the wrong place or not
//      at all.
//
//   2. Escape. spatial.js parks the centred panel on Escape and
//      registered its handler before shell.js existed, so the overlay
//      keymap is a capture-phase listener that stops the event only
//      when it handled the key. Both halves are wrong in a way that
//      only shows up live: too greedy and Escape stops parking panels,
//      too polite and closing a modal also parks the panel behind it.
//
//   3. Deleting a session is the one destructive gesture in the UI, and
//      what makes it safe is a confirm() — which Playwright dismisses
//      by default, so the accept has to be explicit here. The assertion
//      with teeth is the tab: a delete that removed the row and left a
//      live terminal pointed at a session that no longer exists would
//      look fine in the sidebar.
//
// The batch runner's measurements are not asserted here. The mock
// answers /inject with a wake frame and streams its fixture at connect
// time, so a prompt typed during a test never produces a turn-complete
// and never closes a turn. What a browser can say about the runner is
// that its drawer lands on screen and its prompts reach the terminal;
// the columns are pinned in web/shell.test.js instead.

import { test, expect } from '@playwright/test';
import { openSoloSession, openSpatialSession } from './helpers.js';

const OPS = 'ops-triage';

test.describe('smoke: 017-shell-commands', () => {
  test('the command palette offers what the prompt would accept', async ({ page }) => {
    await openSoloSession(page, '001-happy-turn');

    await page.keyboard.press('ControlOrMeta+p');
    const palette = page.locator('#palette-modal');
    await expect(palette).toBeVisible();

    const items = page.locator('#palette-list .palette-item');
    // Built-ins, the shell's own, and whatever the agent advertised —
    // one table, read from the terminal that will dispatch it (#45).
    await expect(items.filter({ hasText: '/tools' })).toHaveCount(1);
    await expect(items.filter({ hasText: '/layout' })).toHaveCount(1);
    await expect(items.filter({ hasText: '/layout' })).toContainText('shell');

    await page.locator('#palette-input').fill('lay');
    await expect(items).toHaveCount(1);

    // Prefilled, not run: /layout takes an argument, and a palette that
    // fired the bare command would have picked the wrong meaning of
    // "select".
    await items.first().click();
    await expect(palette).toBeHidden();
    await expect(page.locator('#solo-body .term:visible .term-prompt')).toHaveValue('/layout ');
  });

  test('/layout and /theme move the whole page, not one panel', async ({ page }) => {
    await openSoloSession(page, '001-happy-turn');
    const input = page.locator('#solo-body .term:visible .term-prompt');

    await input.fill('/layout chat');
    await input.press('Enter');
    await expect(page.locator('body')).toHaveAttribute('data-layout', 'chat');

    await input.fill('/theme mono');
    await input.press('Enter');
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'mono');
    // The HUD picker is the same setting by another route.
    await expect(page.locator('#hud-theme')).toHaveValue('mono');

    // The prompt comes last on purpose. The fixture transcript has no
    // user turn to align, so one has to be typed — and submit() refuses
    // anything typed while a turn is running, slash commands included.
    // The mock never closes this one, so a command after it is a
    // command swallowed.
    await input.fill('does this land on the right?');
    await input.press('Enter');
    // The rule these shells inherit from styles.css — .term-out is a
    // flex column, so the user turn moves to the right margin.
    await expect(page.locator('#solo-body .term:visible .message.user').first()).toHaveCSS(
      'align-self',
      'flex-end'
    );
  });

  test('the session picker opens a session rather than retargeting one', async ({ page }) => {
    await openSoloSession(page, '001-happy-turn');
    await expect(page.locator('.solo-tab')).toHaveCount(1);

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('#picker-modal')).toBeVisible();
    await page.locator('#picker-input').fill('checkout');
    const rows = page.locator('#picker-list .palette-item');
    await expect(rows).toHaveCount(1);
    await rows.first().click();

    // A second tab, not the first one re-pointed: each terminal owns
    // its own client, and retargeting would leave the frame captioning
    // a session it is no longer attached to.
    await expect(page.locator('#picker-modal')).toBeHidden();
    await expect(page.locator('.solo-tab')).toHaveCount(2);
    await expect(page.locator('#status-focus')).toContainText(OPS);
    // Both terminals are still mounted, only the new one is on screen,
    // and — the assertion that would catch a retarget — the one behind
    // it still speaks for the session it was opened with. Transcript
    // text cannot say this: the mock plays the same fixture for every
    // session, so both panes read alike.
    await expect(page.locator('#solo-body .term')).toHaveCount(2);
    await expect(page.locator('#solo-body .term:visible')).toHaveCount(1);
    await expect(page.locator('#solo-body .term:visible')).toHaveAttribute('data-session', OPS);
    await expect(page.locator('#solo-body .term[data-session="smoke-session"]')).toHaveCount(1);
  });

  test('the shortcuts overlay lists the shell and the host shell alike', async ({ page }) => {
    await openSoloSession(page, '001-happy-turn');
    await page.keyboard.press('ControlOrMeta+/');
    const modal = page.locator('#shortcuts-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Command palette');
    // solo.js's own bindings, handed in — an overlay that lists half
    // the keyboard is worse than no overlay.
    await expect(modal).toContainText('Alt+W');
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
  });

  test('the batch drawer lands on screen and reaches the terminal', async ({ page }) => {
    await openSoloSession(page, '001-happy-turn');
    const input = page.locator('#solo-body .term:visible .term-prompt');

    await input.fill('/batch');
    await input.press('Enter');
    const drawer = page.locator('#batch-panel');
    await expect(drawer).toBeVisible();
    // styles.css alone would have put this in the document flow of a
    // shell that has none; chrome.css pins it to the bottom edge.
    await expect(drawer).toHaveCSS('position', 'fixed');
    const box = await drawer.boundingBox();
    const viewport = page.viewportSize();
    expect(box.height).toBeGreaterThan(0);
    expect(Math.round(box.y + box.height)).toBe(viewport.height);

    await page.locator('#batch-input').fill('first prompt\nsecond prompt');
    await page.locator('.batch-actions button').first().click();

    // The first prompt is in flight — the mock never closes the turn,
    // so this is as far as the run gets, and as far as this test asks.
    await expect(page.locator('#batch-results tbody tr')).toHaveCount(2);
    await expect(page.locator('#batch-results tbody tr').first()).toContainText('running');
    await expect(page.locator('#solo-body .term:visible .message.user')).toContainText(
      'first prompt'
    );
  });

  test('deleting a session drops the row and closes its tab', async ({ page }) => {
    // Playwright dismisses dialogs by default, which would make this
    // test pass against a delete that never happened.
    page.on('dialog', (d) => d.accept());

    await page.goto('/solo.html');
    const row = page.locator('.side-session', { hasText: 'Paging alert' });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('.solo-tab')).toHaveCount(1);

    await page.locator('[aria-label="Delete session ' + OPS + '"]').click();
    await expect(page.locator('.side-session', { hasText: 'Paging alert' })).toHaveCount(0);
    // The transcript of a session that no longer exists, with a prompt
    // that can only fail, is not something to leave open.
    await expect(page.locator('.solo-tab')).toHaveCount(0);
  });

  // A declined confirm and a server refusal are covered in
  // web/daemon-sidebar.test.js: both need a stubbed answer from the
  // backend, and the mock accepts every delete it is allowed to see.
  test('Escape closes the overlay without parking the panel behind it', async ({ page }) => {
    await openSpatialSession(page, '001-happy-turn');
    const panel = page.locator('.panel-anchor.active');
    await expect(panel).toHaveCount(1);

    await page.keyboard.press('ControlOrMeta+p');
    await expect(page.locator('#palette-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#palette-modal')).toBeHidden();
    // spatial.js's own Escape handler is on `document` too, so plain
    // stopPropagation would not have stopped it: the modal would close
    // and the panel would fly back to the wall in one keystroke.
    await expect(page.locator('.panel-anchor.active')).toHaveCount(1);

    // And with nothing open, Escape still belongs to the room.
    await page.keyboard.press('Escape');
    await expect(page.locator('.panel-anchor.active')).toHaveCount(0);
  });
});
