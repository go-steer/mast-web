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

// Smoke: 001-happy-turn — the canonical happy path. Fixture streams
// capabilities → status → stream-chunk × N → turn-complete →
// usage-update. The client auto-spawns an observer turn on the first
// stream-chunk (v0.3.0 PR 3) so all events render even without an
// operator prompt.
//
// Ran against index.html until #61 deleted it. Everything below the
// shell is the same terminal.js either way; what moved is where the
// numbers are painted — a per-terminal status row instead of a
// page-wide status bar, because a shell with four transcripts open
// cannot have one.

import { test, expect } from '@playwright/test';
import { openSoloSession } from './helpers.js';

test.describe('smoke: 001-happy-turn', () => {
  test('assistant text renders + per-turn footer stamps', async ({ page }) => {
    const screen = await openSoloSession(page, '001-happy-turn');

    // Assistant text streamed into a .message.assistant row via the
    // auto-spawned observer turn.
    await expect(screen.locator('.message.assistant').first()).toBeVisible();

    // Per-turn footer stamped from turn-complete (latency + tokens).
    // Only present if the observer turn's finish path ran.
    await expect(screen.locator('.turn-footer').first()).toBeVisible();

    // The terminal's own status row reflects the stream: model from
    // status-update, T<n> from the turn that just closed.
    const status = page.locator('#solo-body .term:visible .term-status');
    await expect(status).toContainText('gemini-2.5-flash');
    await expect(status).toContainText('T1');
  });

  // Guard for the vendored browser bundles (web/vendor/). Two ways this
  // has silently broken before and would again without an assertion:
  // terminal.js gates highlighting behind `typeof hljs !== 'undefined'`,
  // so a bundle that fails to evaluate disables syntax highlighting with
  // no error anywhere; and the CSP in each shell's <head> would block
  // the scripts outright if a future edit reintroduced a cross-origin
  // src.
  test('vendored markdown + highlight bundles evaluate under the CSP', async ({ page }) => {
    const violations = [];
    page.on('console', (msg) => {
      if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
    });

    await openSoloSession(page, '001-happy-turn');

    const globals = await page.evaluate(() => ({
      marked: typeof globalThis.marked,
      markedHighlight: typeof globalThis.markedHighlight,
      hljs: typeof globalThis.hljs,
      // The real proof the bundle is a browser build and not the
      // CommonJS entry point: it can actually highlight something.
      highlighted: globalThis.hljs
        ? globalThis.hljs.highlight('const x = 1;', { language: 'javascript' }).value
        : '',
    }));

    expect(globals.marked).toBe('object');
    expect(globals.markedHighlight).toBe('object');
    expect(globals.hljs).toBe('object');
    expect(globals.highlighted).toContain('hljs-keyword');
    expect(violations).toEqual([]);
  });
});
