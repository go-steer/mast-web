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

// Smoke: 003-tool-result-with-latency — v1.2.0 latency_ms sidecar on
// tool-result payloads. Fixture streams a functionCall +
// functionResponse pair where the response includes latency_ms:187.4.
//
// The tool-call event auto-spawns an observer turn (v0.3.0 PR 3), so
// the tool row + latency chip render without an operator prompt.

import { test, expect } from '@playwright/test';
import { connectToMock } from './helpers.js';

test.describe('smoke: 003-tool-result-with-latency', () => {
  test('tool-call chip renders with latency chip from v1.2.0 sidecar', async ({ page }) => {
    await connectToMock(page, '003-tool-result-with-latency');

    // Tool row rendered (auto-spawned observer turn's onToolCall).
    const toolRow = page.locator('#output-area .message.tool-done').first();
    await expect(toolRow).toBeVisible();
    await expect(toolRow.locator('.tool-name')).toContainText('bq_query');

    // Latency chip formatted as "(187ms)" — rounded from the fixture's
    // 187.4 via toFixed(0) in completeToolMessage.
    await expect(toolRow.locator('.tool-latency')).toContainText('187ms');
  });
});
