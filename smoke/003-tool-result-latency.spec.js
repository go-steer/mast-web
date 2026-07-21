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
// tool-result payloads.
//
// Tool-call/result events only render into an active turn (see 001
// spec's header for background). Until v0.3.0 PR 3 (mast-web#23)
// wires observer-mode dispatch, tool-call chips don't render for
// a fixture-only connect. Full assertions on the 187ms latency chip
// deferred to PR 3.
//
// What CAN be verified pre-PR-3: the fixture connects cleanly + the
// SPA's connection state reaches "connected". Basic sanity that the
// mock's SSE handler routes the fixture correctly.

import { test, expect } from '@playwright/test';
import { connectToMock } from './helpers.js';

test.describe('smoke: 003-tool-result-with-latency', () => {
  test('fixture streams end-to-end without connection errors', async ({ page }) => {
    await connectToMock(page, '003-tool-result-with-latency');

    // Basic sanity — the SPA connected + Backend section populated.
    // If the fixture stream broke, we'd get "disconnected" here.
    await expect(page.locator('#status-connection')).toHaveClass(/connected/);
    await expect(page.locator('#session-list')).toContainText(/smoke-session/);
  });
});
