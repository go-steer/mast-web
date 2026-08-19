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

// Smoke: 006-prompt-echo-user-authored — a real backend replays the
// prompt the model received as a user-authored `agent` frame ahead of
// the reply, [Inbox] wrapper and all. The renderer has to drop it, or
// the operator's own message appears inside the agent bubble.
//
// This case reached a browser before it reached CI: every other
// fixture is agent-authored, so nothing exercised the author field
// until the rig ran against a real core-agent. The wire shape here is
// copied from one.

import { test, expect } from '@playwright/test';
import { connectToMock } from './helpers.js';

test.describe('smoke: 006-prompt-echo-user-authored', () => {
  test('the model reply renders and the prompt echo does not', async ({ page }) => {
    await connectToMock(page, '006-prompt-echo-user-authored');

    const output = page.locator('#output-area');
    await expect(output).toContainText('Quite a lot, actually.');

    // The user-authored frame carries "[Inbox]" — a marker no
    // agent-authored frame in any fixture emits, so its absence is
    // specific to this filter rather than to the transcript being
    // empty. The assertion above proves the stream was consumed.
    await expect(output).not.toContainText('[Inbox]');
  });
});
