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

// Smoke: 029-slash-autocomplete — the list that opens over the prompt on a
// leading `/` (v0.7 #43).
//
// The keyboard is the risk: the prompt already owns Enter, and the
// spatial shell owns Escape ("send this panel back"). With the list
// closed neither may change; with it open, Up/Down/Tab/Enter/Esc are its.

import { test, expect } from '@playwright/test';
import { openSoloSession, openSpatialSession, resetTurnRequests, turnRequests } from './helpers.js';

test.describe('smoke: 029-slash-autocomplete', () => {
  test('solo: filter, pick with the keyboard, and the pick is not run', async ({ page }) => {
    await openSoloSession(page);
    await resetTurnRequests(page);
    const term = page.locator('#solo-body .term:visible');
    const prompt = term.locator('.term-prompt');
    const list = term.locator('.term-suggest');

    await prompt.click();
    await prompt.pressSequentially('/guar');
    await expect(list).toBeVisible();
    await expect(list.locator('.term-suggest-cmd').first()).toHaveText('/guardrails');

    await prompt.press('ArrowDown');
    await expect(list.locator('.term-suggest-item[aria-selected="true"]')).toContainText(
      '/guardrails'
    );
    await prompt.press('Enter');
    await expect(prompt).toHaveValue('/guardrails ');
    await expect(list).toBeHidden();
    expect(await turnRequests(page)).toEqual({});
  });

  test('solo: Enter with nothing selected still sends', async ({ page }) => {
    const screen = await openSoloSession(page);
    const prompt = page.locator('#solo-body .term:visible .term-prompt');
    await prompt.click();
    await prompt.pressSequentially('/help');
    await expect(page.locator('#solo-body .term:visible .term-suggest')).toBeVisible();
    await prompt.press('Enter');
    await expect(prompt).toHaveValue('');
    await expect(
      screen.locator('.message.system', { hasText: '/guardrails' }).first()
    ).toBeVisible();
  });

  test('spatial: Esc closes the list first, and only the next one parks', async ({ page }) => {
    await openSpatialSession(page, '001-happy-turn');
    const prompt = page.locator('.panel-anchor.active .term-prompt');
    const list = page.locator('.panel-anchor.active .term-suggest');
    await prompt.click();
    await prompt.pressSequentially('/he');
    await expect(list).toBeVisible();

    await prompt.press('Escape');
    await expect(list).toBeHidden();
    await expect(page.locator('.panel-anchor.active')).toHaveCount(1);

    await prompt.press('Escape');
    await expect(page.locator('.panel-anchor.active')).toHaveCount(0);
  });

  test('a click on a row puts it in the prompt', async ({ page }) => {
    await openSoloSession(page);
    const term = page.locator('#solo-body .term:visible');
    const prompt = term.locator('.term-prompt');
    await prompt.click();
    await prompt.pressSequentially('/who');
    await term.locator('.term-suggest-item', { hasText: '/whoami' }).click();
    await expect(prompt).toHaveValue('/whoami ');
    await expect(prompt).toBeFocused();
  });
});
