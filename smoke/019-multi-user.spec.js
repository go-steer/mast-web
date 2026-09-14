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

// Smoke: 019-multi-user — two operators, one daemon (PR 6, #63).
//
// Everything below this browser is already multi-tenant and already
// tested: core-agent filters GET /sessions per caller, mast-web-server
// asserts the caller to the backend, and dev/tools/e2e-real-backend
// section 5 proves over curl that alice sees her session and bob does
// not. What was never tested is the last hop — whether the page draws
// what it was handed. The mock had exactly one identity, so no test in
// this repo could have failed on a shell that showed one operator
// another operator's roster.
//
// So this file is two people. The mock reads `mock_caller` (mock_acl.go)
// and answers /sessions and /whoami accordingly; the cookie is the
// carrier rather than a header because the SPA's stream is an
// EventSource, and EventSource cannot set a header at all.
//
// The fixture roster, and why it is arranged this way: smoke@ owns
// smoke-session, ops-triage and repo-indexer; bob@ owns docs-writer;
// each has shared one with the other. Both operators therefore see one
// session they own AND one somebody shared, so neither the "mine" nor
// the "shared" branch can go unexercised whichever identity a case
// picks — and each of them has two sessions the other must never see.

import { test, expect } from '@playwright/test';

const SMOKE = 'smoke@example.com';
const BOB = 'bob@example.com';

// Load the solo shell as a given operator. The cookie goes on before
// the first navigation, and storage is cleared before first paint, for
// the same reason the other helpers do it: a saved tab layout would
// restore sessions this case did not ask for — and in this file that
// could mean restoring a tab the operator is not allowed to have.
async function visitAs(page, baseURL, who) {
  await page.context().addCookies([{ name: 'mock_caller', value: who, url: baseURL }]);
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

const rowFor = (page, sid) => page.locator(`.side-session[title*="${sid}"]`);

test.describe('two operators on one daemon', () => {
  // The one that matters. Everything else here is presentation; this is
  // the assertion that fails if a refactor ever starts painting the
  // unfiltered roster — and until the mock had a second identity,
  // nothing in the repo could make that claim at all.
  test('an operator is shown their own roster and nobody else’s', async ({ page, baseURL }) => {
    await visitAs(page, baseURL, BOB);

    // bob owns docs-writer and was shared ops-triage. smoke@'s other
    // two sessions are not his to see, and the sidebar is the only
    // surface that lists sessions nobody has opened.
    await expect(page.locator('.side-session')).toHaveCount(2);
    await expect(rowFor(page, 'docs-writer')).toBeVisible();
    await expect(rowFor(page, 'ops-triage')).toBeVisible();
    await expect(rowFor(page, 'smoke-session')).toHaveCount(0);
    await expect(rowFor(page, 'repo-indexer')).toHaveCount(0);
  });

  test('the default operator still sees the whole fixture roster', async ({ page, baseURL }) => {
    // The regression guard for the identity layer itself: every other
    // spec in this suite is this operator and says nothing about who it
    // is, so if the default ever stopped seeing four sessions the rest
    // of the suite would fail in confusing ways instead of this one
    // failing clearly.
    await visitAs(page, baseURL, SMOKE);
    await expect(page.locator('.side-session')).toHaveCount(4);
  });

  test('a shared session is marked, and your own are not', async ({ page, baseURL }) => {
    await visitAs(page, baseURL, SMOKE);

    const shared = rowFor(page, 'docs-writer');
    await expect(shared).toHaveAttribute('data-own', 'shared');
    // The local part, because every identity in a deployment usually
    // shares a domain and the sidebar column is narrow.
    await expect(shared.locator('.side-session-owner')).toHaveText('bob');

    const mine = rowFor(page, 'ops-triage');
    await expect(mine).toHaveAttribute('data-own', 'mine');
    // No badge on your own rows: nearly every row is yours, and a label
    // on all of them is a label nobody reads.
    await expect(mine.locator('.side-session-owner')).toHaveCount(0);
  });

  // The same row, from the other side. docs-writer is bob's, so for him
  // it is unmarked and deletable — which is what proves the marking is
  // derived from the caller rather than baked into the row.
  test('the marking is relative to who is looking', async ({ page, baseURL }) => {
    await visitAs(page, baseURL, BOB);
    await expect(rowFor(page, 'docs-writer')).toHaveAttribute('data-own', 'mine');
    await expect(rowFor(page, 'ops-triage')).toHaveAttribute('data-own', 'shared');
    await expect(rowFor(page, 'ops-triage').locator('.side-session-owner')).toHaveText('smoke');
  });

  // Admin in the ACL matrix is the owner alone (pkg/auth/authorize.go),
  // so a session you can read is not a session you can destroy.
  // Offering the gesture anyway would only be a way to collect a 403.
  test('a shared session offers no delete control', async ({ page, baseURL }) => {
    await visitAs(page, baseURL, SMOKE);
    await expect(page.locator('[aria-label="Delete session ops-triage"]')).toHaveCount(1);
    await expect(page.locator('[aria-label="Delete session docs-writer"]')).toHaveCount(0);
  });

  test('the shell says who you are, in the HUD and on the daemon', async ({ page, baseURL }) => {
    await visitAs(page, baseURL, BOB);

    // Per daemon, on the daemon: two attached backends can resolve the
    // caller differently, so this is not a window-level fact.
    await expect(page.locator('.side-daemon-name')).toHaveAttribute(
      'title',
      new RegExp('you are ' + BOB)
    );

    // And per terminal once one is open — the same answer arriving by
    // the other route, which is worth pinning because they are two
    // different calls and only one of them is in the sidebar's refresh.
    await rowFor(page, 'docs-writer').click();
    await expect(page.locator('#solo-panel')).toHaveAttribute('data-conn', 'connected');
    await expect(page.locator('#hud-identity')).toHaveText(`${BOB} (via mock)`);
  });

  // Creating a session is what makes you its owner, so the affordance
  // should say so before it is pressed rather than leave the operator
  // to work it out from the row that appears.
  test('the new-session button names the owner it will stamp', async ({ page, baseURL }) => {
    await visitAs(page, baseURL, BOB);
    await expect(page.locator('.side-daemon .side-icon[title^="New session"]')).toHaveAttribute(
      'title',
      new RegExp('owned by ' + BOB)
    );
  });
});
