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

// Smoke: 004-observer-mode-usage-update-only — turn-complete arrives
// with NO cost_usd; authoritative per-turn cost comes from the
// following usage-update.last_turn. This test proves the fixture
// streams end-to-end + the per-turn footer renders.
//
// The observer-mode-specific bits (StampLatestAssistantFooter equivalent,
// backfill from /usage snapshot) land with v0.3.0 PR 3 (mast-web#23).
// When PR 3 ships, extend this test to assert on the stamped
// per-turn footer's cost field (currently footer renders but cost
// may be zero without the last_turn backfill).

import { test, expect } from '@playwright/test';
import { connectToMock } from './helpers.js';

test.describe('smoke: 004-observer-mode-usage-update-only', () => {
  test('renders streaming text + per-turn footer end to end', async ({ page }) => {
    await connectToMock(page, '004-observer-mode-usage-update-only');

    // Assistant streams "Observer sees this".
    const assistantMsg = page.locator('#output-area .message.assistant').first();
    await expect(assistantMsg).toContainText('Observer sees this');

    // Per-turn footer renders after turn-complete. Fixture ships
    // tokens_in: 12, tokens_out: 4.
    await expect(page.locator('#output-area .turn-footer').first()).toContainText('12');
  });
});
