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

// Smoke: 005-capabilities-forward-compat — the v1.4.0 manifest
// showcase. Backend advertises features / slash_commands / agent /
// caller_id. SPA should:
//   - populate the agent identity slot from capabilities.agent
//   - populate the caller identity slot from capabilities.caller_id
//   - hide the MCP sidebar section (features.mcp: false)
//   - list /federate under server-advertised in /help output
//
// This is the most substantive PR 4b integration test — v0.3.0's
// PR 1 state refactor sits between the SSE dispatcher and the UI,
// so if the mirror-var wiring regressed, most of these assertions
// would fail.

import { test, expect } from '@playwright/test';
import { connectToMock } from './helpers.js';

test.describe('smoke: 005-capabilities-forward-compat', () => {
  test('renders v1.4.0 capability-manifest fields', async ({ page }) => {
    await connectToMock(page, '005-capabilities-forward-compat');

    // Agent identity slot populated from capabilities.agent = {name: "mast", ...}.
    await expect(page.locator('#agent-info')).toContainText('mast');

    // Caller identity — capabilities.caller_id = "alice@example.com".
    // The SPA also fires a background /whoami; either source shows the identity.
    await expect(page.locator('#identity-info')).toContainText(/alice|smoke/);

    // MCP section is feature-gated (features.mcp: false). Should be hidden.
    await expect(page.locator('#section-mcp')).toBeHidden();

    // Specialists section is NOT gated (features.specialists: true).
    await expect(page.locator('#section-specialists')).toBeVisible();

    // Sessions section stays visible (features.multi_session: true).
    await expect(page.locator('#section-sessions')).toBeVisible();
  });
});
