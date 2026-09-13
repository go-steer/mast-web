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
// showcase. The backend advertises features / slash_commands / agent /
// caller_id, and the client has to do something with each.
//
// This spec used to check four sidebar slots in index.html. Three of
// those questions are now asked in the vocabulary the surviving shells
// have, and asked in 016 against this same fixture: features.mcp:false
// hides /mcp from /help and from dispatch, features.specialists:true
// leaves /specialists, and slash_commands shows up under "Advertised by
// this agent". What is left here is the pair 016 does not cover — who
// the backend says it is, and who it says you are.

import { test, expect } from '@playwright/test';
import { openSoloSession } from './helpers.js';

test.describe('smoke: 005-capabilities-forward-compat', () => {
  test('the manifest names the agent and the caller', async ({ page }) => {
    const screen = await openSoloSession(page, '005-capabilities-forward-compat');

    // capabilities.agent — name, version, and the model/provider it is
    // configured with. index.html painted this into a sidebar slot; a
    // terminal has no sidebar slot, so it answers /model, which is
    // already the question it belongs to (#61).
    const input = page.locator('#solo-body .term:visible .term-prompt');
    await input.fill('/model');
    await input.press('Enter');
    const out = screen.locator('.message.system').last();
    await expect(out).toContainText('Agent: mast 0.1.0-dev (gemini-2.5-pro via vertex)');
    await expect(out).toContainText('Lean fork of core-agent');

    // The caller. capabilities.caller_id is "alice@example.com"; the
    // terminal also fires a background /whoami, and the mock answers
    // that for its own smoke identity — either source filling the slot
    // is the thing under test, not which one won.
    await expect(page.locator('#hud-identity')).toHaveText(/alice|smoke/);
  });
});
