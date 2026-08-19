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

// Smoke: 009-spatial-slash-command — a slash command typed into a
// spatial panel dispatches to the backend instead of being sent to the
// model as chat.
//
// The bug this pins is a silent one. terminal.js handled /clear and let
// everything else fall through to client.inject(), so typing /compact
// posted the literal string "/compact" as a prompt: the agent got chat
// text, the model burned a turn on it, and nothing in the transcript
// said anything had gone wrong. The classic shell has always dispatched
// these properly, so the two shells disagreed about what a "/" means.
//
// The DOM assertion alone wouldn't catch a regression — a wrongly
// injected /compact still renders *something* in the transcript. The
// turn tally is the part with teeth: dispatching a slash command must
// post no /inject at all.
//
// Fixture 005 is the one that advertises slash_commands in its
// capabilities frame, which is what terminal.js checks before
// dispatching. The mock answers /sessions/{sid}/slash/<name> with a
// markdown _render body, so this also exercises SlashRender end to end.

import { test, expect } from '@playwright/test';
import { openSpatialSession, resetTurnRequests, turnRequests } from './helpers.js';

test.describe('smoke: 009-spatial-slash-command', () => {
  test('an advertised slash command dispatches and renders, without a turn', async ({ page }) => {
    const screen = await openSpatialSession(page, '005-capabilities-forward-compat');
    await resetTurnRequests(page);

    const input = page.locator('.panel-anchor.active .term-prompt');
    await input.fill('/compact');
    await input.press('Enter');

    // SlashRender's markdown renderer puts the mock's reply in the
    // transcript as command output.
    const output = screen.locator('.message.system.cmd-output', { hasText: '/slash/compact' });
    await expect(output).toBeVisible();

    // Not chat: no user row, and — the assertion that actually pins the
    // bug — no turn was requested.
    await expect(screen.locator('.message.user')).toHaveCount(0);
    expect(await turnRequests(page)).toEqual({});
  });

  test('an unadvertised slash command is refused rather than sent as chat', async ({ page }) => {
    const screen = await openSpatialSession(page, '005-capabilities-forward-compat');
    await resetTurnRequests(page);

    const input = page.locator('.panel-anchor.active .term-prompt');
    await input.fill('/definitely-not-a-command');
    await input.press('Enter');

    await expect(
      screen.locator('.message.system', { hasText: 'Unknown command' })
    ).toBeVisible();
    expect(await turnRequests(page)).toEqual({});
  });

  test('/help lists what the agent advertises', async ({ page }) => {
    const screen = await openSpatialSession(page, '005-capabilities-forward-compat');

    const input = page.locator('.panel-anchor.active .term-prompt');
    await input.fill('/help');
    await input.press('Enter');

    const help = screen.locator('.message.system', { hasText: '/compact' });
    await expect(help).toBeVisible();
    await expect(help).toContainText('/federate');
  });
});
