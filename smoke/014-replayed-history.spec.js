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

// Smoke: 014-replayed-history — attaching to a session that has been
// running shows what it already said.
//
// The server re-streams the whole eventlog on attach. Those frames are
// classified as replay (attach-core/replay.js) and used to be dropped,
// so a reload showed an empty transcript over a live conversation
// (#51). Fixture 010 is that session: six turns stamped last month,
// then a live turn with no timestamp at all.
//
// What this pins, beyond "history appears":
//
//   - the cap. Three turns are drawn and the other three are not,
//     because "draw everything" is the thousand-turn scroll the replay
//     filter exists to prevent.
//   - the rest is reachable. The control at the top hands back the
//     older turns from the buffer — no re-fetch, because the server
//     already sent them — and then admits there is nothing left.
//   - no invented footers. The log carries no turn-complete, so a
//     replayed turn has no duration to report and doesn't claim one.
//   - the clock. A replayed row wears the timestamp the wire gave it,
//     not the one it was drawn at. Asserted on seconds, which survive
//     every real UTC offset.
//   - the [Inbox] wrapper comes off the prompt echo. Live it is
//     suppressed outright; in history it is the only copy of the
//     prompt there is, so it is drawn as the operator typed it.

import { test, expect } from '@playwright/test';
import { connectToMock, openSpatialSession, openSoloSession } from './helpers.js';

const FIXTURE = '010-attach-mid-session';

const NEWEST_THREE = ['is that still good?', 'and once it is open?', 'put it back'];
const OLDEST_THREE = ['what have we got in the cupboard?', 'open the jar', 'since when?'];

async function expectHistoryOnAttach(rows) {
  const block = rows.locator('.replay-history');
  await expect(block).toBeVisible();

  // The cap: the newest three turns, and only those.
  await expect(block.locator('.history-turn')).toHaveCount(3);
  for (const prompt of NEWEST_THREE) {
    await expect(block.locator('.message.user', { hasText: prompt })).toHaveCount(1);
  }
  for (const prompt of OLDEST_THREE) {
    await expect(block.locator('.message.user', { hasText: prompt })).toHaveCount(0);
  }

  // A replayed prompt is the operator's words, not the envelope the
  // model was handed them in.
  await expect(rows).not.toContainText('[Inbox]');

  // No fabricated durations: the log has no turn-complete in it.
  await expect(block.locator('.turn-footer')).toHaveCount(0);

  // The live turn is below the rule, in the transcript proper, and it
  // does get a footer.
  await expect(block).not.toContainText('You were putting the marmalade back.');
  await expect(rows.locator('.message.assistant').last()).toContainText(
    'You were putting the marmalade back.'
  );
  await expect(rows.locator('.turn-footer')).toHaveCount(1);
  await expect(rows.locator('.turn-footer')).toContainText('2.21s');

  // The boundary marker itself.
  await expect(block.locator('.history-rule')).toContainText('earlier in this session');
}

// Wire clock, not draw clock. The last replayed turn is stamped
// 09:11:00Z (prompt) and 09:11:02Z (reply); every real UTC offset is a
// whole number of minutes, so the seconds survive whatever timezone
// this runs in — while "now" would have to be those exact seconds twice
// in a row to fake it.
async function expectWireTimestamps(rows) {
  const stamps = rows.locator('.replay-history .history-turn').last().locator('.msg-time');
  await expect(stamps.nth(0)).toHaveText(/:00\]$/);
  await expect(stamps.nth(1)).toHaveText(/:02\]$/);
}

async function expectShowEarlier(rows) {
  const block = rows.locator('.replay-history');
  const more = block.locator('.history-more');

  await expect(more).toBeEnabled();
  await expect(more).toContainText('show 3 earlier turns');
  await expect(more).toContainText('3 left');

  await more.click();

  await expect(block.locator('.history-turn')).toHaveCount(6);
  for (const prompt of OLDEST_THREE) {
    await expect(block.locator('.message.user', { hasText: prompt })).toHaveCount(1);
  }
  // Older turns land above the ones already drawn, not under them.
  await expect(block.locator('.message.user').first()).toContainText(OLDEST_THREE[0]);
  // History is the same transcript, not a text dump: the replayed tool
  // call is a tool row, with its result folded in.
  await expect(block.locator('.message.tool-done')).toHaveCount(1);
  await expect(block.locator('.message.tool-done')).toContainText('fs_read');

  // Nothing left to hand back, and the control says which kind of
  // nothing rather than sitting there looking clickable.
  await expect(more).toBeDisabled();
  await expect(more).toContainText('start of this session');
}

test.describe('smoke: 014-replayed-history', () => {
  test('classic shell draws the replayed transcript', async ({ page }) => {
    await connectToMock(page, FIXTURE);
    const rows = page.locator('#output-area');
    await expectHistoryOnAttach(rows);
    await expectWireTimestamps(rows);

    // Below the boot banner — that is this view's furniture, not
    // something the session said.
    await expect(page.locator('#output-area > .boot-banner + .replay-history')).toHaveCount(1);
  });

  test('classic shell hands back older turns on request', async ({ page }) => {
    await connectToMock(page, FIXTURE);
    await expectShowEarlier(page.locator('#output-area'));
  });

  test('classic shell hands back older turns on scrolling to the top', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await connectToMock(page, FIXTURE);
    const block = page.locator('#output-area .replay-history');
    const scrollTo = (top) =>
      page.locator('#output-area').evaluate((el, y) => {
        el.scrollTop = y === 'bottom' ? el.scrollHeight : y;
        el.dispatchEvent(new Event('scroll'));
      }, top);
    await expect(block.locator('.history-turn')).toHaveCount(3);

    // A transcript that fits on screen sits at scrollTop 0 from the
    // start. Reaching the top there is not a gesture, and a layout jolt
    // that fires a scroll event must not empty the buffer onto the page.
    await scrollTo(0);
    await expect(block.locator('.history-turn')).toHaveCount(3);

    // Make it overflow, and the top becomes somewhere the operator has
    // to travel to — arriving there is the same request as pressing the
    // button.
    await page.setViewportSize({ width: 1280, height: 320 });
    await expect
      .poll(() => page.locator('#output-area').evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);
    // Settle at the bottom first, where a fresh attach leaves you: the
    // resize itself moves the transcript, and that move is not the
    // gesture either.
    await scrollTo('bottom');
    await expect(block.locator('.history-turn')).toHaveCount(3);

    await scrollTo(0);
    await expect(block.locator('.history-turn')).toHaveCount(6);
  });

  test('spatial shell draws the replayed transcript', async ({ page }) => {
    const screen = await openSpatialSession(page, FIXTURE);
    const rows = screen.locator('.term-out');
    await expectHistoryOnAttach(rows);
    await expectWireTimestamps(rows);
    await expectShowEarlier(rows);
  });

  test('solo shell draws the replayed transcript', async ({ page }) => {
    const screen = await openSoloSession(page, FIXTURE);
    const rows = screen.locator('.term-out');
    await expectHistoryOnAttach(rows);
    await expectWireTimestamps(rows);
    await expectShowEarlier(rows);
  });
});
