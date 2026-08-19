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

// Smoke: 011-turn-cost-ordering — a turn footer shows its own cost even
// when usage-update arrives before turn-complete.
//
// turn-complete.cost_usd is optional and core-agent omits it entirely
// (verified on the wire against 2.9.0-dev): the priced-out number rides
// on usage-update.last_turn. Both shells assumed that update would
// arrive *after* the footer was stamped and back-filled whatever footer
// was most recent. core-agent emits it before, so the cost was written
// to the previous turn's footer — the newest turn never showed a cost,
// and every cost that did show belonged to the turn after the one it
// was printed under.
//
// Fixture 008 pins that ordering with turn-completes carrying no
// cost_usd at all, so a footer showing a price can only have got it
// from usage-update.last_turn. Three differently-priced turns, each
// pinning something a single turn couldn't:
//
//   turn 1 — usage-update first. The claim has to survive being
//            stashed before the footer that wants it exists.
//   turn 2 — usage-update first again, different price. A renderer
//            that only back-fills the most recent footer (what
//            terminal.js did) stamps turn 2's price onto turn 1 and
//            leaves turn 2 bare; with one turn that same bug just
//            looks like a missing cost.
//   turn 3 — usage-update *after* turn-complete. Both orderings are
//            legal on the wire, so the back-fill path stays live and
//            has to hit turn 3 without restamping turn 2.

import { test, expect } from '@playwright/test';
import { connectToMock, openSpatialSession } from './helpers.js';

const FIXTURE = '008-usage-before-turn-complete';

// Each turn's own tokens and its own server-priced cost.
async function expectPerTurnCosts(root) {
  const footers = root.locator('.turn-footer');
  await expect(footers).toHaveCount(3);
  await expect(footers.nth(0)).toContainText('5009↑ / 57↓ tokens');
  await expect(footers.nth(0)).toContainText('$0.000596');
  await expect(footers.nth(1)).toContainText('6142↑ / 318↓ tokens');
  await expect(footers.nth(1)).toContainText('$0.001139');
  await expect(footers.nth(2)).toContainText('7003↑ / 122↓ tokens');
  await expect(footers.nth(2)).toContainText('$0.000923');
  // No price may appear on a second footer as well as its own.
  await expect(root.locator('.turn-footer', { hasText: '$0.001139' })).toHaveCount(1);
  await expect(root.locator('.turn-footer', { hasText: '$0.000923' })).toHaveCount(1);
}

test.describe('smoke: 011-turn-cost-ordering', () => {
  test('classic shell footers claim the cost that arrived early', async ({ page }) => {
    await connectToMock(page, FIXTURE);
    await expectPerTurnCosts(page.locator('#output-area'));
  });

  test('spatial shell footers claim the cost that arrived early', async ({ page }) => {
    const screen = await openSpatialSession(page, FIXTURE);
    await expectPerTurnCosts(screen);
  });
});
