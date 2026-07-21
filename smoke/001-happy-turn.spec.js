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

// Smoke: 001-happy-turn — the canonical happy path.
//
// The SPA's stream-chunk / tool-call / tool-result handlers only
// render into an active turn (created by submitPrompt → runPrompt),
// so a fixture that just streams into a fresh connection doesn't
// paint assistant text or tool chips — the events fire but drop.
// That's the observer-mode gap; full assistant-side rendering
// lands with v0.3.0 PR 3 (mast-web#23, StampLatestAssistantFooter
// equivalent + externally-driven turns).
//
// Until PR 3 lands, this spec asserts on the connect-time surface
// that DOES render without an active turn:
//   - status-update fields flow into the status bar (model)
//   - usage-update fields flow into the status bar (turn counter,
//     cost cell)
//   - the sidebar's Backend / Sessions sections populate from mock
//     endpoints
// When PR 3 ships, add:
//   - assistant text streams into a .message.assistant row
//   - tool-call chip renders with the tool name
//   - per-turn footer stamps with tokens

import { test, expect } from '@playwright/test';
import { connectToMock } from './helpers.js';

test.describe('smoke: 001-happy-turn', () => {
  test('connect + capabilities/status/usage flow into status bar + sidebar', async ({ page }) => {
    await connectToMock(page, '001-happy-turn');

    // status-update.model → status bar (renders whether or not an
    // active turn exists).
    await expect(page.locator('#status-model')).toContainText('gemini-2.5-flash');

    // usage-update.turns_total → turn counter (fixture ships 1).
    await expect(page.locator('#status-turns')).toContainText('1');

    // Cost cell is present (fixture cost rounds to $0.00 under the
    // .toFixed(2) formatter; assert on presence, not value).
    await expect(page.locator('#status-cost')).toBeVisible();

    // Backend section populated (mock's canned session name).
    await expect(page.locator('#session-list')).toContainText(/smoke-session/);
  });
});
