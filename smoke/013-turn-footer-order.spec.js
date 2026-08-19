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

// Smoke: 013-turn-footer-order — a turn's footer lands under its reply,
// even though the reply's last frame arrives after turn-complete.
//
// core-agent emits turn-complete from its turn loop while the final
// agent frame is still in flight behind it: measured against a live
// backend (gemini-3.7-flash on Vertex), the reply landed 38ms *after*
// the completion frame. Both shells finished the turn on arrival, so
// the footer was stamped first and the tail of the answer was orphaned
// into a fresh observer turn below it — the transcript read
//
//   AGENT: The capital of Portugal is
//   4.58s · 5009↑ / 7↓ tokens · $0.000409
//   AGENT: Lisbon.
//
// Fixture 009 pins that ordering. Two turns, because one is not enough
// to catch the interesting half: holding the turn open past
// turn-complete fixes the orphaned tail, and a hold that never lets go
// would then swallow the *next* turn's reply into the same bubble. The
// second turn's inbox frame is what closes the first, and this is the
// test that says so.
//
// The assertion is on child order rather than on text, because both
// halves of the fix are order bugs and text alone would pass on a
// transcript that reads reply/reply/footer/footer.

import { test, expect } from '@playwright/test';
import { connectToMock, openSpatialSession, openSoloSession } from './helpers.js';

const FIXTURE = '009-turn-complete-before-final-frame';

// The transcript's rows, reduced to the two kinds this test is about.
// Anything else in there — boot banner, the attach line, message
// actions — is noise for these purposes.
async function replyFooterOrder(rows) {
  return rows.evaluate((el) =>
    Array.from(el.children)
      .map((c) => {
        if (c.classList.contains('turn-footer')) return 'footer';
        if (c.classList.contains('assistant')) return 'reply';
        return null;
      })
      .filter(Boolean)
  );
}

async function expectFooterUnderItsReply(rows) {
  // Both turns have to have landed before order means anything.
  await expect(rows.locator('.turn-footer')).toHaveCount(2);

  // One bubble per turn, each holding the whole answer: the frame that
  // arrived after turn-complete belongs to the turn it completes, and
  // the one that arrived after the *next* turn started does not.
  const replies = rows.locator('.message.assistant');
  await expect(replies).toHaveCount(2);
  await expect(replies.nth(0)).toContainText('The capital of Portugal is Lisbon.');
  await expect(replies.nth(1)).toContainText('The capital of Spain is Madrid.');

  // Each footer carries its own turn's numbers, under its own reply.
  const footers = rows.locator('.turn-footer');
  await expect(footers.nth(0)).toContainText('4.58s');
  await expect(footers.nth(0)).toContainText('5009↑ / 7↓ tokens');
  await expect(footers.nth(1)).toContainText('3.90s');
  await expect(footers.nth(1)).toContainText('5093↑ / 7↓ tokens');

  expect(await replyFooterOrder(rows)).toEqual(['reply', 'footer', 'reply', 'footer']);
}

test.describe('smoke: 013-turn-footer-order', () => {
  test('classic shell stamps the footer after the reply', async ({ page }) => {
    await connectToMock(page, FIXTURE);
    await expectFooterUnderItsReply(page.locator('#output-area'));
  });

  test('spatial shell stamps the footer after the reply', async ({ page }) => {
    const screen = await openSpatialSession(page, FIXTURE);
    await expectFooterUnderItsReply(screen.locator('.term-out'));
  });

  test('solo shell stamps the footer after the reply', async ({ page }) => {
    const screen = await openSoloSession(page, FIXTURE);
    await expectFooterUnderItsReply(screen.locator('.term-out'));
  });
});
