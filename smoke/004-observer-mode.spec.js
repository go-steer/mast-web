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

// Smoke: 004-observer-mode — the client is attached as an observer to a
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
//
// The banner only existed in app.js until #61; retiring that shell is
// what found the gap, and this spec is the reason it is a gap that got
// closed rather than one that got deleted.

import { test, expect } from '@playwright/test';
import { openSoloSession } from './helpers.js';

test.describe('smoke: 004-observer-mode', () => {
  test('observer banner + auto-turn renders + footer back-fills cost', async ({ page }) => {
    const screen = await openSoloSession(page, '004-observer-mode-usage-update-only');

    // Read-only variant banner (live_agent:false).
    const banner = screen.locator('.term-observer');
    await expect(banner).toContainText('Attached as observer');
    await expect(banner).toContainText('runs autonomously');
    // Pinned, not appended: app.js appended, so the one notice that
    // explains why the prompt does what it does scrolled away with the
    // second screenful. The sticky rule is one line of panel.css and
    // fails silently.
    await expect(banner).toHaveCSS('position', 'sticky');

    // Externally-driven turn: assistant text rendered without any
    // operator prompt — the client auto-created an observer turn on the
    // first stream-chunk.
    await expect(screen.locator('.message.assistant')).toContainText('Observer sees this');

    // Footer stamped with cost back-filled from last_turn.cost_usd
    // (0.00004 → "$0.000040"). turn-complete alone doesn't carry
    // cost_usd; if back-fill regressed we'd see the footer without
    // the "$…" segment.
    const footer = screen.locator('.turn-footer').last();
    await expect(footer).toContainText('$0.000040');
    await expect(footer).toContainText('12↑ / 4↓ tokens');
  });
});
