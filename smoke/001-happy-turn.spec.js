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

// Smoke: 001-happy-turn — the canonical happy path. Fixture streams
// capabilities → status → stream-chunk × N → turn-complete →
// usage-update. The SPA auto-spawns an observer turn on the first
// stream-chunk (v0.3.0 PR 3) so all events render even without an
// operator prompt.

import { test, expect } from '@playwright/test';
import { connectToMock } from './helpers.js';

test.describe('smoke: 001-happy-turn', () => {
  test('assistant text renders + per-turn footer stamps', async ({ page }) => {
    await connectToMock(page, '001-happy-turn');

    // Assistant text streamed into a .message.assistant row via the
    // auto-spawned observer turn.
    await expect(page.locator('#output-area .message.assistant').first()).toBeVisible();

    // Per-turn footer stamped from turn-complete (latency + tokens).
    // Only present if the observer turn's finish path ran.
    await expect(page.locator('#output-area .turn-footer').first()).toBeVisible();

    // Status-bar reflections of the stream.
    await expect(page.locator('#status-model')).toContainText('gemini-2.5-flash');
    await expect(page.locator('#status-turns')).toContainText('1');
  });
});
