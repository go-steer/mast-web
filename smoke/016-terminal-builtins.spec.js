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
// terminal.js answers itself, rather than posting to the agent.
//
// Most of them read a REST endpoint the slash channel doesn't expose,
// so "did it work" is not a question the agent can be asked. Until PR 2
// (#59) they existed only in app.js, which means the shells that
// survive v0.4 could not answer them at all — a panel terminal was a
// lesser terminal, and the plan is to delete the shell that wasn't.
// PR 3 (#60) added the rest, and the capability gate over all of them.
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

  test('/mcp buckets the same catalog by server', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, screen, '/mcp');

    const out = screen.locator('.message.system.cmd-output').last();
    await expect(out).toContainText('MCP servers (3)');
    // github is attributed the unflattened way (source:'mcp' + server),
    // gke the flattened way, kube not at all — the naming-convention
    // fallback is the only thing that finds it.
    await expect(out.locator('.list-group-header', { hasText: 'github' })).toHaveCount(1);
    await expect(out.locator('.list-group-header', { hasText: 'gke' })).toHaveCount(1);
    await expect(out.locator('.list-group-header', { hasText: 'kube' })).toHaveCount(1);
    // The built-ins are not MCP servers. app.js's version split every
    // underscored name and invented one called "fs".
    await expect(out).not.toContainText('fs —');
    expect(await turnRequests(page)).toEqual({});
  });

  test('/specialists reports model and modes', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, screen, '/specialists');

    const out = screen.locator('.message.system.cmd-output').last();
    await expect(out).toContainText('Specialists (2)');
    await expect(out).toContainText('mock-model-1.5');
    await expect(out).toContainText('sync/async');
    expect(await turnRequests(page)).toEqual({});
  });

  test('/sessions lists the backend roster, newest first', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, screen, '/sessions');

    const out = screen.locator('.message.system.cmd-output').last();
    await expect(out).toContainText('Sessions (4)');
    // Titled rows show the title and keep the id underneath; untitled
    // ones show the id. Both paths are in the mock's roster on purpose.
    await expect(out).toContainText('Paging alert on checkout-api');
    await expect(out).toContainText('repo-indexer');
    // The panel's own session is marked, so the list answers "where am
    // I" as well as "what else is there".
    await expect(out).toContainText('this panel');
    expect(await turnRequests(page)).toEqual({});
  });

  test('/guardrails reports watchdog and ceiling state', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, screen, '/guardrails');

    const out = screen.locator('.message.system').last();
    await expect(out).toContainText('mode=warn tripped=false');
    await expect(out).toContainText('$0.02 / $10.00');
    expect(await turnRequests(page)).toEqual({});
  });

  test('/guardrails reset clears the trip', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, screen, '/guardrails reset all');

    await expect(screen.locator('.message.system').last()).toContainText('Guardrails reset');
    expect(await turnRequests(page)).toEqual({});
  });

  test('/model reports the model and says switching is not a thing', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, screen, '/model');

    const out = screen.locator('.message.system').last();
    // From the fixture's status-update, which is where the model comes
    // from — there is no model endpoint to ask.
    await expect(out).toContainText('Model: gemini-2.5-flash');
    await expect(out).toContainText('does not exist yet');
    expect(await turnRequests(page)).toEqual({});
  });

  // /export is scraped from this panel's own container, not from a
  // global query — in a workspace, app.js's version would have exported
  // whichever transcript happened to be on screen.
  test('/export downloads this panel transcript', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    const download = page.waitForEvent('download');
    await run(page, screen, '/export md');

    expect((await download).suggestedFilename()).toBe('mast-session-smoke-session.md');
    await expect(screen.locator('.message.system').last()).toContainText('as md.');
    expect(await turnRequests(page)).toEqual({});
  });

  test('/help lists every available built-in', async ({ page }) => {
    const screen = await openSoloSession(page);
    await run(page, screen, '/help');
    const help = screen.locator('.message.system').last();

    for (const name of [
      '/help',
      '/clear',
      '/export',
      '/tools',
      '/mcp',
      '/subagents',
      '/specialists',
      '/sessions',
      '/guardrails',
      '/pause',
      '/continue',
      '/abandon',
      '/model',
      '/usage',
      '/whoami',
    ]) {
      await expect(help).toContainText(name);
    }
    // The default fixture advertises none, and saying so is better than
    // a silent gap where a section would be. The gating block below
    // runs against a fixture that does advertise some.
    await expect(help).toContainText('This agent advertises no slash commands.');
    // Nothing is gated off against the default fixture, so the
    // not-supported footer should be absent rather than empty.
    await expect(help).not.toContainText('Not supported by this backend');
  });

  // #45: the built-ins used to 404 instead of hiding. The fix is that
  // /help and dispatch ask the same question of the same table — a
  // command cannot be listed and then refuse, which is the shape of
  // core-tui#275/#276.
  //
  // Fixture 005 declares mcp:false and says nothing about guardrails,
  // so it covers both halves of the rule at once: an explicit false
  // hides, and an absent key stays on (protocol §2.1, additive).
  test.describe('capability gating', () => {
    const GATED = '005-capabilities-forward-compat';

    test('a gated-off built-in is absent from /help', async ({ page }) => {
      const screen = await openSoloSession(page, GATED);
      await run(page, screen, '/help');
      const help = screen.locator('.message.system').last();

      await expect(help).toContainText('Not supported by this backend: /mcp');
      // Named in the footer, absent from the list itself.
      await expect(help).not.toContainText('MCP servers and what each contributes');
      // Absent from `features` entirely, so still on.
      await expect(help).toContainText('/guardrails');
      // Explicitly true.
      await expect(help).toContainText('/specialists');
      // This fixture does advertise some, so the section is populated
      // rather than replaced by the "advertises no slash commands" line.
      await expect(help).toContainText('Advertised by this agent:');
      await expect(help).toContainText('/compact');
    });

    test('invoking one says so, and posts nothing', async ({ page }) => {
      const screen = await openSoloSession(page, GATED);
      await resetTurnRequests(page);
      await run(page, screen, '/mcp');

      // A name we know and cannot serve is a different answer from one
      // we don't know — the operator learns the backend is the limit.
      await expect(screen.locator('.message.system').last()).toContainText(
        '/mcp is not supported by this backend.'
      );
      await expect(screen.locator('.message.system').last()).not.toContainText('Unknown command');
      expect(await turnRequests(page)).toEqual({});
    });
  });
});
