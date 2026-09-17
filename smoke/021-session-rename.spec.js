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

// Smoke: 021-session-rename — POST /sessions/{sid}/title from the
// sidebar (PR 3, #92).
//
// Protocol 1.6.0 started inferring session titles and the sidebar has
// rendered them since v0.4; 1.10.0 (#808) added the manual override.
// The gesture is on the row rather than in a terminal because the
// roster is the surface that lists sessions nobody has opened, and a
// name is what you give a thing so you can find it later.
//
// The unit suite covers the contract's edges — cancel versus clear,
// persisted:false, the two refusals. What only a browser can show is
// that the name went to the server and not just to the DOM, which is
// what the reload in each case below is for.

import { test, expect } from '@playwright/test';

const rowFor = (page, sid) => page.locator(`.side-session[title*="${sid}"]`);
const nameOf = (page, sid) => rowFor(page, sid).locator('.side-session-id');
const renameControl = (page, sid) => page.locator(`[aria-label="Rename session ${sid}"]`);

// window.prompt, answered once. `null` dismisses, which is the cancel
// the endpoint treats as "leave the name alone" — as opposed to '',
// which is a real instruction to clear it.
function answerPrompt(page, text) {
  page.once('dialog', function (dialog) {
    if (text === null) return dialog.dismiss();
    return dialog.accept(text);
  });
}

async function visit(page) {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch (_e) {
      /* blocked storage — the shell falls back to same-origin anyway */
    }
  });
  await page.goto('/solo.html');
  await expect(page.locator('.side-session').first()).toBeVisible();
}

// Titles are mock state that outlives a page, so a case that renamed
// something would otherwise hand the next one a roster it did not set
// up. Same reset the ACL uses — one endpoint clears both side tables.
test.beforeEach(async ({ page }) => {
  const res = await page.request.delete('/_mock/share-state');
  expect(res.ok()).toBeTruthy();
});

test.describe('smoke: 021-session-rename', () => {
  test('renaming a row renames the session', async ({ page }) => {
    await visit(page);
    // repo-indexer is untitled in the fixture roster, so its wide slot
    // shows the id — which is the state a rename exists to improve.
    await expect(nameOf(page, 'repo-indexer')).toHaveText('repo-indexer');

    answerPrompt(page, 'Indexing the monorepo');
    await renameControl(page, 'repo-indexer').click();
    await expect(nameOf(page, 'repo-indexer')).toHaveText('Indexing the monorepo');
    // The id does not disappear when a title arrives: it is what
    // correlates a row with an event log or a URL.
    await expect(rowFor(page, 'repo-indexer').locator('.side-session-meta')).toHaveText(
      'repo-indexer'
    );

    // The assertion with teeth. Everything above would pass on a
    // sidebar that only edited its own DOM.
    await page.reload();
    await expect(nameOf(page, 'repo-indexer')).toHaveText('Indexing the monorepo');
  });

  test('an emptied box clears the name and re-arms inference', async ({ page }) => {
    await visit(page);
    // ops-triage ships with a title, so this is the clear path rather
    // than a rename of something that never had one.
    await expect(nameOf(page, 'ops-triage')).toHaveText('Paging alert on checkout-api');

    answerPrompt(page, '');
    await renameControl(page, 'ops-triage').click();
    await expect(nameOf(page, 'ops-triage')).toHaveText('ops-triage');

    await page.reload();
    await expect(nameOf(page, 'ops-triage')).toHaveText('ops-triage');
  });

  test('a cancelled prompt leaves the name alone', async ({ page }) => {
    await visit(page);
    answerPrompt(page, null);
    await renameControl(page, 'ops-triage').click();
    await expect(nameOf(page, 'ops-triage')).toHaveText('Paging alert on checkout-api');

    await page.reload();
    await expect(nameOf(page, 'ops-triage')).toHaveText('Paging alert on checkout-api');
  });

  // The 200 answers with what was STORED, after the host's
  // normalization — a 60-rune cap here. A client that painted the
  // string it sent would show a name the server does not have.
  test('the row shows what was stored, not what was typed', async ({ page }) => {
    await visit(page);
    answerPrompt(page, 'x'.repeat(70));
    await renameControl(page, 'repo-indexer').click();
    await expect(nameOf(page, 'repo-indexer')).toHaveText('x'.repeat(60));
  });

  // Title is ActionSessionWrite, which a contributor has and a viewer
  // does not — and the roster does not say which one you are on a
  // session somebody shared. A control that worked on half the rows it
  // appeared on would be worse than one that appears on fewer.
  test('a session somebody shared offers no rename control', async ({ page }) => {
    await visit(page);
    await expect(rowFor(page, 'docs-writer')).toHaveAttribute('data-own', 'shared');
    await expect(renameControl(page, 'docs-writer')).toHaveCount(0);
    await expect(renameControl(page, 'ops-triage')).toHaveCount(1);
  });
});
