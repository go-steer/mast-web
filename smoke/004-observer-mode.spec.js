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

// Smoke: 004-observer-mode — the SPA is attached as an observer to a
// session someone (or something) else is driving. Fixture advertises
// features.observer_mode:true + live_agent:false, then streams a
// stream-chunk + turn-complete + priced usage-update.
//
// Asserts on the v0.3.0 PR 3 observer-turn behavior:
//   - Observer banner (read-only variant) surfaces.
//   - Externally-driven assistant text renders (auto-created observer
//     turn — no operator prompt required).
//   - Per-turn footer stamps with latency + tokens, then back-fills
//     the authoritative cost from usage-update.last_turn.cost_usd.

import { test, expect } from '@playwright/test';
import { connectToMock } from './helpers.js';

test.describe('smoke: 004-observer-mode', () => {
  test('observer banner + auto-turn renders + footer back-fills cost', async ({ page }) => {
    await connectToMock(page, '004-observer-mode-usage-update-only');

    // Read-only variant banner (live_agent:false).
    await expect(page.locator('#observer-banner')).toContainText('Attached as observer');
    await expect(page.locator('#observer-banner')).toContainText('runs autonomously');

    // Externally-driven turn: assistant text rendered without any
    // operator prompt — the SPA auto-created an observer turn on the
    // first stream-chunk.
    await expect(page.locator('#output-area .message.assistant')).toContainText(
      'Observer sees this'
    );

    // Footer stamped with cost back-filled from last_turn.cost_usd
    // (0.00004 → "$0.000040"). turn-complete alone doesn't carry
    // cost_usd; if back-fill regressed we'd see the footer without
    // the "$…" segment.
    const footer = page.locator('#output-area .turn-footer').last();
    await expect(footer).toContainText('$0.000040');
    await expect(footer).toContainText('12 in / 4 out tokens');
  });
});
