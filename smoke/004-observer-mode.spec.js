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
// with NO cost_usd; per-turn cost comes from the following
// usage-update.last_turn.
//
// Full observer-mode dispatch (StampLatestAssistantFooter equivalent
// that stamps footer metadata from turn-complete + last_turn even
// when there's no active turn) is v0.3.0 PR 3's work (mast-web#23).
// Until then, the SPA's stream-chunk / tool-call / turn-complete
// handlers all drop when activeTurn is null, so the assistant
// message and per-turn footer don't render from a fixture-only
// connect.
//
// What CAN be verified pre-PR-3: usage-update.turns_total flows into
// the status bar (that path doesn't need an active turn).

import { test, expect } from '@playwright/test';
import { connectToMock } from './helpers.js';

test.describe('smoke: 004-observer-mode-usage-update-only', () => {
  test('usage-update flows into status bar independent of active turn', async ({ page }) => {
    await connectToMock(page, '004-observer-mode-usage-update-only');

    // Fixture ships turns_total: 1.
    await expect(page.locator('#status-turns')).toContainText('1');
    // Model name flows in from status-update.
    await expect(page.locator('#status-model')).toContainText('gemini-2.5-flash');
  });
});
