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

// Smoke: 008-one-turn-per-prompt — one submitted prompt must produce
// exactly one turn request, in both shells.
//
// The bug this pins: /inject already wakes the agent (InjectAs ends in
// RequestWake, core-agent pkg/agent/inbox.go), so the paired
// /inject + /wake ran every prompt twice. Against a live agent that
// meant two turn-complete events and two replies; against a real model
// it would be two billed round-trips.
//
// It survived a full green suite because the mock replays its fixture
// on connect and streams it regardless of what the SPA posts — the
// transcript looks identical whether one turn was requested or five.
// So this spec asserts on the mock's write tally rather than on the
// DOM, which is the only place the difference is visible.
//
// Note the assertion is `wake` absent, not `inject === 1` alone: the
// first wrong fix swapped the pair for a single POST /wake {prompt},
// which core-agent's own handler expands right back into inject +
// wake. Counting only injects would have called that green.

import { test, expect } from '@playwright/test';
import { connectToMock, openSpatialSession, resetTurnRequests, turnRequests } from './helpers.js';

test.describe('smoke: 008-one-turn-per-prompt', () => {
  test('the classic shell asks for exactly one turn', async ({ page }) => {
    await connectToMock(page);
    await resetTurnRequests(page);

    await page.fill('#prompt-input', 'one turn please');
    await page.click('#send-btn');
    await expect(page.locator('#output-area .message.user')).toHaveCount(1);

    expect(await turnRequests(page)).toEqual({ inject: 1 });
  });

  test('the spatial shell asks for exactly one turn', async ({ page }) => {
    const screen = await openSpatialSession(page);
    await resetTurnRequests(page);

    const input = page.locator('.panel-anchor.active .term-prompt');
    await input.fill('one turn please');
    await input.press('Enter');
    await expect(screen.locator('.message.user')).toHaveCount(1);

    expect(await turnRequests(page)).toEqual({ inject: 1 });
  });
});
