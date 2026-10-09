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

// Smoke: 027-run-error — "delivered, with a warning" (#108).
//
// core-agent#1154: a subagent that called return_result and THEN failed
// (a 429, a stream error) hands back `output` as the deliverable and
// `run_error` as a separate fact about the run. The row used to read a
// plain ✓ Used, with the run_error visible only to someone who opened the
// JSON. It must not read ✗ Failed either: that says the result is junk.
//
// Fixture 016 is that call: spawn_agent, returned_then_failed.

import { test, expect } from '@playwright/test';
import { openSoloSession } from './helpers.js';

test.describe('smoke: 027-run-error', () => {
  test('a result delivered before the run failed reads used, with a warning', async ({ page }) => {
    const screen = await openSoloSession(page, '016-run-error');
    const row = screen.locator('.message.tool-done').first();

    await expect(row.locator('.tool-icon')).toHaveText('✓');
    await expect(row.locator('.tool-verb')).toHaveText('Used');
    await expect(row).not.toHaveClass(/tool-error/);
    await expect(row.locator('.tool-warning')).toHaveText(
      '⚠ run failed after returning: 429 RESOURCE_EXHAUSTED: quota exceeded for model requests'
    );

    // And the deliverable is still one click away, unchanged.
    await row.locator('.tool-row').click();
    await expect(row.locator('.json-viewer')).toContainText('Outage began 14:02 UTC');
  });
});
