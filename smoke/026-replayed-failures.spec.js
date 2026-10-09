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

// Smoke: 026-replayed-failures — a failure survives a reload (v0.6 #114).
//
// Until protocol 1.19.0 a guardrail trip and a turn error reached only the
// clients attached when they happened. Attach a minute later, or reload,
// and the session showed a turn that simply stopped (core-agent#1258).
// 1.19.0 writes each to the event log, and they replay as content-less
// `agent` frames; mast-web used to drop every one of them.
//
// Fixture 015 is such a session: a turn cut by a per-turn cost trip, then
// a turn that ended rate-limited, all stamped last week. It's in the event
// log's own order, where the cut's cancel row comes BEFORE the trip row
// that explains it. The history still has to absorb that cancel.

import { test, expect } from '@playwright/test';
import { openSoloSession } from './helpers.js';

test.describe('smoke: 026-replayed-failures', () => {
  test('replayed history shows the trip and the error, not turns that just stop', async ({
    page,
  }) => {
    const screen = await openSoloSession(page, '015-replayed-failures');
    const history = screen.locator('.replay-history');

    // The trip, with the producer's reason, in the turn it cut.
    await expect(history.locator('.guardrail-trip')).toHaveCount(1);
    await expect(history.locator('.guardrail-trip')).toContainText(
      '⚠ guardrail tripped · cost_ceiling · the turn was cut'
    );
    await expect(history).toContainText('the session is NOT halted');
    // The cancel it caused says nothing the trip didn't, so it's absorbed,
    // even though the log holds it first.
    await expect(history).not.toContainText('Turn canceled');

    // The second turn's real failure is still news, and still says so.
    await expect(history).toContainText('Turn error: rate_limited: quota exceeded');

    // And both prompts are there: history, not a transcript of failures.
    await expect(history).toContainText('summarise all forty incident reports');
    await expect(history).toContainText('try again, twelve at a time');
  });
});
