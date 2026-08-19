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

// Smoke: 012-solo-shell — the flat single-terminal shell (solo.html).
//
// This page exists because the spatial shell's terminals are the part
// people actually want, and the room is in the way when you are working
// with one agent. It wears the same chrome, so most of what could break
// here is CSS the room already tests. What is genuinely new — and what
// these tests pin — is the tab model:
//
//   1. Every open session stays mounted and connected, whether or not
//      it is on screen. This is the whole reason the shell keeps a
//      hidden terminal rather than rebuilding on switch, and it is
//      invisible from the visible tab: an implementation that tore down
//      the background sessions would look identical until you switched
//      back and found the transcript missing. Asserting on a *hidden*
//      transcript's content is the assertion with teeth.
//
//   2. Exactly one terminal is displayed. `.term` sets display:flex,
//      which beats the [hidden] attribute's UA rule — so hiding a tab
//      depends on one line of solo.css and fails open (all four
//      transcripts stacked) if it goes.
//
//   3. The frame follows the selected tab: hue, title, status line.
//
//   4. Closing and reloading keep the strip coherent.
//
// The multi-tab tests deliberately pass no ?fixture=, so the mock gives
// each demo session a different transcript (sessionFixtures in mock.go)
// and "the right tab is showing" is a checkable claim rather than four
// identical screens.

import { test, expect } from '@playwright/test';
import { openSoloSession } from './helpers.js';

// The mock's roster, in the order /sessions returns it — which is the
// order "open all" creates tabs in, and therefore the order alt+1…9
// counts in.
const OPS = 'ops-triage'; // fixture 003 — a tool row with 187ms latency
const DOCS = 'docs-writer'; // fixture 004 — observer mode
const REPO = 'repo-indexer'; // fixture 002 — cost ceiling tripped mid-turn

async function openAll(page) {
  await page.goto('/solo.html');
  const all = page.locator('.side-daemon .side-icon[title^="Open all"]');
  await expect(all).toBeEnabled();
  await all.click();
  await expect(page.locator('.solo-tab')).toHaveCount(4);
}

test.describe('smoke: 012-solo-shell', () => {
  test('a single session opens into the frame', async ({ page }) => {
    const screen = await openSoloSession(page, '001-happy-turn');

    await expect(screen.locator('.message.assistant')).toContainText('Hello world');
    await expect(page.locator('.solo-tab')).toHaveCount(1);
    await expect(page.locator('#hud-count')).toHaveText('1 session');
    await expect(page.locator('#status-focus')).toContainText('smoke-session');
  });

  test('background tabs stay connected and keep streaming off screen', async ({ page }) => {
    await openAll(page);

    // Four live terminals, one on screen. `:visible` rather than
    // `:not([hidden])` on purpose: the attribute is set by solo.js, but
    // whether it *does* anything rests on one line of solo.css — .term
    // is display:flex, which beats the UA rule for [hidden] — and that
    // line fails open, stacking all four transcripts on top of each
    // other. Asserting on the attribute would not notice.
    await expect(page.locator('#solo-body .term')).toHaveCount(4);
    await expect(page.locator('#solo-body .term:visible')).toHaveCount(1);
    await expect(page.locator(`#solo-body .term[data-session="${REPO}"]`)).toBeHidden();

    // …and the three that were never displayed still received their own
    // streams. If the shell only connected the visible tab, or rebuilt
    // terminals on switch, these transcripts would be empty.
    await expect(page.locator(`.term[data-session="${REPO}"]`)).toContainText(
      'Cost ceiling reached'
    );
    await expect(page.locator(`.term[data-session="${OPS}"] .tool-latency`)).toContainText('187ms');
    await expect(page.locator(`.term[data-session="${DOCS}"]`)).toContainText('attached');
  });

  test('switching tabs swaps the transcript and repaints the frame', async ({ page }) => {
    await openAll(page);

    const hue = () =>
      page.evaluate(() =>
        getComputedStyle(document.getElementById('solo-panel')).getPropertyValue('--hue').trim()
      );
    const firstHue = await hue();

    await page.locator('.solo-tab').nth(2).click();

    // The third tab is the one on screen, and it is the only one.
    const visible = page.locator('#solo-body .term:visible');
    await expect(visible).toHaveCount(1);
    await expect(visible).toHaveAttribute('data-session', DOCS);

    await expect(page.locator('.solo-tab[aria-selected="true"]')).toContainText(DOCS);
    await expect(page.locator('#status-focus')).toContainText(DOCS);
    // Hue slot 3, not slot 1: the frame wears the selected tab's colour
    // so the shell reads the same way the room does.
    expect(await hue()).not.toBe(firstHue);
  });

  // Teeth: the prompt textarea has focus from the moment a tab opens,
  // and terminal.js stops keydown propagation there so the room's bare
  // camera keys don't fire while you type. That guard used to swallow
  // modifier chords too, which made this shortcut dead on arrival —
  // silently, since clicking the tab still worked.
  test('alt+2 selects the second tab', async ({ page }) => {
    await openAll(page);
    await expect(page.locator('#solo-body .term:visible .term-prompt')).toBeFocused();

    await page.keyboard.press('Alt+2');

    await expect(page.locator('#solo-body .term:visible')).toHaveAttribute(
      'data-session',
      OPS
    );
  });

  test('closing the selected tab tears its terminal down and falls back', async ({ page }) => {
    await openAll(page);
    await expect(page.locator('#solo-body .term:visible')).toHaveAttribute(
      'data-session',
      'smoke-session'
    );

    await page.locator('#btn-close').click();

    // Gone from the strip *and* from the DOM — a closed tab that stays
    // mounted is a session still holding an SSE connection open.
    await expect(page.locator('.solo-tab')).toHaveCount(3);
    await expect(page.locator('.term[data-session="smoke-session"]')).toHaveCount(0);
    await expect(page.locator('#hud-count')).toHaveText('3 sessions');

    // The neighbour takes over rather than the frame going empty.
    await expect(page.locator('#solo-body .term:visible')).toHaveAttribute(
      'data-session',
      OPS
    );
    await expect(page.locator('#solo-empty')).toBeHidden();
  });

  test('the tab layout survives a reload', async ({ page }) => {
    // No storage clearing here: the point is what persists. Playwright
    // gives each test a fresh context, so this starts empty anyway.
    await page.goto('/solo.html');
    await page.locator('.side-session').first().click();
    await page.locator('.side-session').nth(2).click();
    await expect(page.locator('.solo-tab')).toHaveCount(2);
    await expect(page.locator('.solo-tab[aria-selected="true"]')).toContainText(DOCS);

    await page.reload();

    await expect(page.locator('.solo-tab')).toHaveCount(2);
    await expect(page.locator('#solo-body .term')).toHaveCount(2);
    await expect(page.locator('.solo-tab[aria-selected="true"]')).toContainText(DOCS);
    await expect(page.locator('#solo-body .term:visible')).toHaveAttribute(
      'data-session',
      DOCS
    );
  });

  test('the empty frame says so', async ({ page }) => {
    await page.goto('/solo.html');

    await expect(page.locator('#solo-empty')).toBeVisible();
    await expect(page.locator('.solo-tab')).toHaveCount(0);
    await expect(page.locator('#hud-count')).toHaveText('0 sessions');
  });
});
