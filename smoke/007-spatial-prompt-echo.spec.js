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

// Smoke: 007-spatial-prompt-echo — 006 again, but through the spatial
// shell's renderer.
//
// There used to be two renderers: index.html loaded app.js and the
// spatial shell loaded terminal.js, so every render-side filter had to
// be written twice. 006's filter landed in app.js and the spatial copy
// went missing, which a live core-agent found before CI did — the
// operator's own prompt rendered inside the AGENT bubble, [Inbox]
// wrapper and all. #61 deleted app.js and the duplication with it, so
// this pair is now the same code in two frames; kept as a pair because
// 006 is how we would find out if that ever stopped being true.

import { test, expect } from '@playwright/test';
import { openSpatialSession } from './helpers.js';

test.describe('smoke: 007-spatial-prompt-echo', () => {
  test('the model reply renders and the prompt echo does not', async ({ page }) => {
    const panel = await openSpatialSession(page, '006-prompt-echo-user-authored');

    await expect(panel).toContainText('Quite a lot, actually.');

    // "[Inbox]" appears only in the user-authored frame — no
    // agent-authored frame in any fixture emits it — so its absence is
    // specific to this filter rather than to an empty transcript. The
    // assertion above proves the stream was consumed.
    await expect(panel).not.toContainText('[Inbox]');
  });
});
