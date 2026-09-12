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

// Smoke: 016-terminal-builtins — the client-side slash commands
// terminal.js answers itself: /tools, /subagents, /usage, /whoami.
//
// Each of these reads a REST endpoint the slash channel doesn't expose,
// so "did it work" is not a question the agent can be asked. Until PR 2
// (#59) they existed only in app.js, which means the shells that
// survive v0.4 could not answer them at all — a panel terminal was a
// lesser terminal, and the plan is to delete the shell that wasn't.
//
// The assertion with teeth in every case is the turn tally: a built-in
// that fell through to the generic dispatch would post the literal
// string to the model and render *something*, so a DOM check alone
// proves nothing. No turn, and no request to the agent, is the fact.
//
// 009 covers the other half of the precedence rule (an advertised name
// dispatching to the backend); this covers the built-in half.

import { test, expect } from '@playwright/test';
import { openSoloSession, resetTurnRequests, turnRequests } from './helpers.js';

async function run(page, screen, command) {
  const input = page.locator('#solo-body .term:visible .term-prompt');
  await input.fill(command);
  await input.press('Enter');
  return screen;
}

test.describe('smoke: 016-terminal-builtins', () => {
  test('/tools groups the catalog by source, without a turn', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, screen, '/tools');

    const out = screen.locator('.message.system.cmd-output').last();
    // The mock's catalog spans six sources, which is the only reason
    // the grouped path is reachable at all — a five-builtin stub would
    // have exercised the single-source path and nothing else.
    await expect(out).toContainText(
      'Tools (11): builtin 3 · github 1 · gke 2 · skill 2 · subagent 1 · other 2'
    );
    await expect(out.locator('.list-group-header').first()).toHaveText('builtin (3)');
    // Two skills, one heading — the fold (core-tui#289).
    await expect(out.locator('.list-group-header', { hasText: 'skill' })).toHaveCount(1);
    // Grouped mode drops descriptions and keeps the gate.
    await expect(out).not.toContainText('Read files');
    await expect(out).toContainText('[prompted]');

    expect(await turnRequests(page)).toEqual({});
  });

  test('/tools <source> narrows to one source and restores descriptions', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, screen, '/tools builtin');

    const out = screen.locator('.message.system.cmd-output').last();
    await expect(out).toContainText('Tools from builtin (3)');
    await expect(out).toContainText('Read files');
    await expect(out).not.toContainText('gke_nodes_list');
    expect(await turnRequests(page)).toEqual({});
  });

  // A miss that only says "no" is a dead end: filtering by source is the
  // only reason to want the source names, so the miss has to supply them.
  test('/tools with an unknown source names the sources that exist', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, screen, '/tools nope');

    await expect(screen.locator('.message.system').last()).toContainText(
      'no tools from "nope". Sources: builtin, github, gke, skill, subagent, other'
    );
    expect(await turnRequests(page)).toEqual({});
  });

  test('/subagents lists the configured roster', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, screen, '/subagents');

    const out = screen.locator('.message.system.cmd-output').last();
    await expect(out).toContainText('Configured subagents');
    await expect(out).toContainText('researcher');
    await expect(out).toContainText('implementer');
    expect(await turnRequests(page)).toEqual({});
  });

  test('/usage reports session totals and the per-model split', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, screen, '/usage');

    const out = screen.locator('.message.system').last();
    await expect(out).toContainText('Session usage');
    await expect(out).toContainText('Turns:');
    await expect(out).toContainText('mock-model-1.5');
    expect(await turnRequests(page)).toEqual({});
  });

  test('/whoami reports the resolved identity and fills the HUD slot', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);

    // The HUD slot fills on its own — /whoami fires in the background
    // once the capabilities frame lands, because an identity nobody
    // asked for is the only kind a status bar can show.
    await expect(page.locator('#hud-identity')).toHaveText('smoke@example.com (via mock)');

    await run(page, screen, '/whoami');
    await expect(screen.locator('.message.system').last()).toContainText('smoke@example.com');
    expect(await turnRequests(page)).toEqual({});
  });

  test('/help lists the built-ins', async ({ page }) => {
    const screen = await openSoloSession(page);
    await run(page, screen, '/help');
    const help = screen.locator('.message.system').last();

    await expect(help).toContainText('/tools');
    await expect(help).toContainText('/subagents');
    await expect(help).toContainText('/usage');
    await expect(help).toContainText('/whoami');
  });
});
