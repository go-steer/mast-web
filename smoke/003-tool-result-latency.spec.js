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

// Smoke: 003-tool-result-with-latency — two tool-results, one with
// a v1.2.0 latency_ms sidecar (187.4), one without. Verifies the
// SPA surfaces per-call latency in the tool chip.

import { test, expect } from '@playwright/test';
import { connectToMock } from './helpers.js';

test.describe('smoke: 003-tool-result-with-latency', () => {
  test('renders tool-call rows with latency where present', async ({ page }) => {
    await connectToMock(page, '003-tool-result-with-latency');

    // Fixture uses bq_query as the tool name. Wait for at least one
    // tool-call chip to render.
    await expect(
      page.locator('#output-area').getByText(/bq_query/i).first()
    ).toBeVisible();

    // Latency 187ms surfaces in the completed tool chip. The SPA
    // formats latency values in its tool renderer; matching on the
    // digits keeps this stable across CSS changes.
    const latencyRow = page.locator('#output-area').getByText(/187/).first();
    await expect(latencyRow).toBeVisible();
  });
});
