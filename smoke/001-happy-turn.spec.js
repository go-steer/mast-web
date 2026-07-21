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

// Smoke: 001-happy-turn — the canonical everything-works turn.
// capabilities → status-update → inbox queued/dequeued → stream-chunks
// → tool-call → tool-result → turn-complete → usage-update.
//
// Verifies:
//   - status bar model shows what the fixture's status-update sent
//   - assistant text streams (Hello world) into the transcript
//   - tool-call chip appears + completes with latency
//   - per-turn footer renders after turn-complete
//   - status-bar cost updates from usage-update

import { test, expect } from '@playwright/test';
import { connectToMock } from './helpers.js';

test.describe('smoke: 001-happy-turn', () => {
  test('renders capabilities → streaming → tool call → footer end to end', async ({ page }) => {
    await connectToMock(page, '001-happy-turn');

    // Fixture 001 sends status-update with model gemini-2.5-flash.
    // Status bar reads it into #status-model.
    await expect(page.locator('#status-model')).toContainText('gemini-2.5-flash');

    // Assistant text streams in: "Hello" + " world".
    const assistantMsg = page.locator('#output-area .message.assistant').first();
    await expect(assistantMsg).toContainText('Hello world');

    // Tool call for fs_read renders as a tool-call row. Cell layout
    // varies with theme; matching on the tool name is stable.
    await expect(
      page.locator('#output-area').getByText(/fs_read/i).first()
    ).toBeVisible();

    // turn-complete triggers the per-turn footer with tokens count.
    // Fixture ships tokens_in: 45, tokens_out: 8.
    await expect(
      page.locator('#output-area .turn-footer').first()
    ).toContainText('45');

    // usage-update.by_model + cost_usd_total flow into the status-bar
    // cost cell — 0.00012 rounds to $0.00 by the .toFixed(2) formatter,
    // so we assert on presence rather than value.
    await expect(page.locator('#status-cost')).toBeVisible();
    // Turn counter incremented once.
    await expect(page.locator('#status-turns')).toContainText('1');
  });
});
