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

// Smoke: 002-cost-ceiling-mid-turn — turn-error kind=cost_ceiling
// fires mid-stream. Client should render a persistent "cost ceiling
// reached" system message (v0.2.0 PR 4b banner + v0.3.0 PR 1's
// setCostCeilingHit(true) store update).

import { test } from '@playwright/test';
import { connectToMock, waitForSystemMessage } from './helpers.js';

test.describe('smoke: 002-cost-ceiling-mid-turn', () => {
  test('surfaces cost-ceiling system message on turn-error', async ({ page }) => {
    await connectToMock(page, '002-cost-ceiling-mid-turn');
    // Fixture ends with turn-error kind=cost_ceiling; dispatcher
    // renders a system message.
    await waitForSystemMessage(page, 'Cost ceiling reached');
  });
});
