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

// Smoke: 023-attribution — absence means unknown, never none. (#94.)
//
// Three reads that share nothing but that rule, and each of them has a
// blank the wire can hand back:
//
//   /perms          — a decision the daemon could not attribute
//                     (v1.10.0, core-agent#830).
//   /specialists    — a specialist that reports no tool grant
//                     (v1.9.0, core-agent#768).
//   /subagents stop — a subagent that had already finished
//                     (v1.12.0, core-agent#897).
//
// In all three the tempting render is a confident one — this browser's
// user, "no tools", "stopped" — and in all three it is wrong in the
// case an operator consults it for. So every assertion below is paired:
// the populated row AND the blank one, from the same read, because a
// fixture with only populated rows lets a renderer that assumes pass.
//
// The permission card needs a prompt, and the mock has no permission
// checker because it has no tools — so the prompt is injected the same
// way a turn is, via POST /_mock/perms-prompt. The log it writes to is
// per-process state, so it is cleared at both ends.

import { test, expect } from '@playwright/test';
import { openSoloSession, resetTurnRequests, turnRequests } from './helpers.js';

const SID = 'smoke-session';
// The mock's default identity — whoever the SPA is when nothing sets a
// `mock_caller` cookie (mock_acl.go).
const SMOKE = 'smoke@example.com';

async function run(page, command) {
  const input = page.locator('#solo-body .term:visible .term-prompt');
  await input.fill(command);
  await input.press('Enter');
}

const lastOutput = (screen) => screen.locator('.message.system').last();

async function clearPermsLog(page) {
  const res = await page.request.delete('/_mock/perms-log');
  expect(res.ok()).toBeTruthy();
}

// Somebody's agent reaches for something gated.
async function raisePrompt(page, body) {
  const res = await page.request.post('/_mock/perms-prompt', {
    data: { session: SID, ...(body || {}) },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id;
}

// The prompt stream is a second EventSource the panel opens after it
// attaches, and a hub publish with nobody subscribed goes nowhere — so
// a raise fired the instant the panel reports `connected` can be
// swallowed. Retry until a card shows up. Extra raises are harmless:
// an unanswered prompt writes nothing to the log.
async function raiseUntilCarded(page, screen, body) {
  const card = screen.locator('.message.perms-request').first();
  await expect(async () => {
    await raisePrompt(page, body);
    await expect(card).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  return card;
}

test.beforeEach(async ({ page }) => {
  await clearPermsLog(page);
});

test.afterEach(async ({ page }) => {
  await clearPermsLog(page);
});

test.describe('smoke: 023-attribution', () => {
  // The log is the reason /perms exists at all: an allow-session
  // granted an hour ago is invisible in every other surface, and since
  // v1.10.0 the row can say who granted it.
  test('/perms names who approved what, and says when nobody can be named', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, '/perms');

    const out = lastOutput(screen);
    await expect(out).toContainText('Permissions — mode ask');
    // The standing posture, which is what "mode ask" is qualified by.
    await expect(out.locator('.list-group-header', { hasText: 'allow' })).toBeVisible();
    await expect(out).toContainText('bash_exec rm -rf *');

    await expect(
      out.locator('.list-group-header', { hasText: 'approved this session' })
    ).toHaveText('approved this session (2)');
    // The pair. One decision the daemon verified an identity for, and
    // one it did not — and the second says so rather than borrowing the
    // identity of whoever is reading the log.
    await expect(out).toContainText(`bash_exec git push`);
    await expect(out).toContainText(`by ${SMOKE}`);
    await expect(out).toContainText('fs_write /etc/hosts');
    await expect(out).toContainText('unattributed');
    // A backend that CAN attribute says nothing about backends that
    // cannot; the mock is 1.12.0, so the footer note must be absent.
    await expect(out).not.toContainText('does not attribute approvals');

    expect(await turnRequests(page)).toEqual({});
  });

  // #768's blank. `implementer` carries no `tools` key, which a
  // pre-1.9.0 daemon sends for every specialist and a current one sends
  // for a specialist configured with no grant of its own.
  test('/specialists reports an unknown grant as unknown, not as none', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, '/specialists');

    const out = lastOutput(screen);
    await expect(out).toContainText('Specialists (2)');
    // The one that reported a grant, summarized the way /tools leads.
    await expect(out).toContainText('builtin 1 · gke 1');
    await expect(out).toContainText('grant unknown');
    await expect(out).not.toContainText('no tools of its own');
    await expect(out).toContainText('1 report no grant, which is not the same as none');

    expect(await turnRequests(page)).toEqual({});
  });

  test('/specialists <name> opens the grant, grouped by source', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);
    await run(page, '/specialists researcher');

    const out = lastOutput(screen);
    await expect(out).toContainText('researcher — mock-model-1.5 · sync/async');
    await expect(out.locator('.list-group-header').first()).toHaveText('builtin (1)');
    await expect(out).toContainText('List GKE clusters');
    // Two sources, two headings — the same fold /tools does, and the
    // reason the detail view is worth having over a flat name list.
    await expect(out.locator('.list-group-header')).toHaveCount(2);
    await expect(out).toContainText('2 tool(s): builtin 1 · gke 1');

    expect(await turnRequests(page)).toEqual({});
  });

  // Both reasons, because they lead to different next steps: upgrade
  // the daemon, or look at the specialist's configuration.
  test('/specialists <name> with no grant names both reasons for the blank', async ({ page }) => {
    const screen = await openSoloSession(page);
    await run(page, '/specialists implementer');

    const out = lastOutput(screen);
    await expect(out).toContainText('Tool grant: unknown');
    await expect(out).toContainText('predates v1.9.0');
    await expect(out).toContainText('configured with no tools of its own');
  });

  // #897's blank. `stopped` used to mean "the name is registered"; it
  // now means "this call is what halted it", and the mock answers both.
  test('/subagents stop distinguishes stopping one from finding it finished', async ({ page }) => {
    const screen = await openSoloSession(page);
    await resetTurnRequests(page);

    await run(page, '/subagents stop researcher');
    await expect(lastOutput(screen)).toContainText('Stopped subagent "researcher"');
    await expect(lastOutput(screen)).toContainText('It ended as "stopped"');

    // The case the change was filed about: through 1.11.0 this answered
    // `stopped: true` and told the operator they had halted something
    // that finished before they clicked.
    await run(page, '/subagents stop implementer');
    await expect(lastOutput(screen)).toContainText('had already finished before the stop arrived');
    await expect(lastOutput(screen)).not.toContainText('Stopped subagent "implementer"');

    // And a name the manager never registered stays a miss, not a
    // silent success.
    await run(page, '/subagents stop ghost');
    await expect(lastOutput(screen)).toContainText('/subagents stop ghost failed');

    expect(await turnRequests(page)).toEqual({});
  });

  // The card, where the same question is asked about the click that
  // just happened rather than about a row from an hour ago.
  test('the permission card records who the daemon attributed the click to', async ({ page }) => {
    const screen = await openSoloSession(page);
    const card = await raiseUntilCarded(page, screen, {
      tool: 'bash_exec',
      detail: 'rm -rf ./build',
    });
    await expect(card).toContainText('rm -rf ./build');

    await card.getByRole('button', { name: 'ALLOW ONCE' }).click();

    // The buttons are replaced by what was decided, and then by who the
    // daemon says decided it. Not this browser's guess — the SPA never
    // sends an approver, because the server checks that field against
    // its own verdict rather than believing it.
    await expect(card.locator('.perms-outcome')).toHaveText('allow-once');
    await expect(card.locator('.perms-approver')).toHaveText(`by ${SMOKE}`);
  });

  // The other half of the same fact: the decision the card recorded is
  // the row the log grows, attributed to the same identity. Two reads
  // of one truth, which is the only way to catch a card that displays
  // an approver the daemon never wrote down.
  test('a card answered in the browser lands in the log under the same name', async ({ page }) => {
    const screen = await openSoloSession(page);
    const card = await raiseUntilCarded(page, screen, {
      tool: 'kube_apply',
      detail: 'apply -f prod.yaml',
    });
    await card.getByRole('button', { name: 'ALLOW SESSION' }).click();
    await expect(card.locator('.perms-outcome')).toHaveText('allow-session-tool');

    await run(page, '/perms');
    const out = lastOutput(screen);
    await expect(
      out.locator('.list-group-header', { hasText: 'approved this session' })
    ).toHaveText('approved this session (3)');
    // The tool the operator was looking at, not a placeholder: the
    // correlation between a prompt and its decision is what makes the
    // log readable at all.
    await expect(out.locator('.list-item').last()).toContainText('kube_apply');
    await expect(out.locator('.list-item').last()).toContainText(`by ${SMOKE}`);
  });
});
