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

// Smoke: 010-grounding-citations — Gemini grounding evidence renders as
// a search row and a sources strip, not as body text.
//
// core-agent projects a turn's grounding metadata into synthetic events
// (pkg/models/gemini/projection.go): one per search query, one per
// grounded web source, each a plain text part authored
// "gemini/google_search" and shaped "query: …" or "<title> — <uri>".
// Both shells used to route every non-user chunk into onToken, so nine
// of those landed inside the assistant's markdown bubble, concatenated
// with no separator — a wall of opaque vertexaisearch redirect URLs
// glued onto the end of the reply.
//
// The assertion with teeth is the negative one: no "vertexaisearch"
// anywhere in .md-content. Rendering the strip correctly while *also*
// still streaming the raw lines into the bubble would satisfy every
// positive assertion here.
//
// Fixture 007 mirrors a real captured turn, including the three cases
// the parser has to survive: a source repeated across two search rounds
// (deduped on URI), a title that contains em-dashes of its own (the
// split anchors on the last " — " before the URL), and a source Vertex
// shipped with no title at all (falls back to the hostname).

import { test, expect } from '@playwright/test';
import { connectToMock, openSpatialSession } from './helpers.js';

const FIXTURE = '007-grounding-google-search';

// One assertion set, run against whichever shell's transcript root.
async function expectGroundingRendered(root) {
  // Queries collapse into a single search row rather than one row each.
  const search = root.locator('.message.builtin-tool');
  await expect(search).toHaveCount(1);
  await expect(search).toContainText('🔍 Search');
  await expect(search).toContainText('"Fable" AI model OR LLM');
  await expect(search).toContainText('"Opus and Fable"');

  // Five source events, four distinct URIs.
  const sources = root.locator('.citation-sources a');
  await expect(sources).toHaveCount(4);
  await expect(sources.nth(0)).toHaveText('[1] gitconnected.com');
  await expect(sources.nth(1)).toHaveText('[2] substack.com');
  await expect(sources.nth(2)).toHaveText('[3] Claude — an AI assistant — anthropic.com');
  // Untitled source: no title to show, so the hostname stands in.
  await expect(sources.nth(3)).toHaveText('[4] vertexaisearch.cloud.google.com');
  await expect(sources.nth(0)).toHaveAttribute('href', /grounding-api-redirect/);

  // The reply itself is intact and free of evidence text.
  const body = root.locator('.md-content');
  await expect(body.first()).toContainText('Grounded answer text.');
  await expect(root.locator('.md-content', { hasText: 'vertexaisearch' })).toHaveCount(0);
  await expect(root.locator('.md-content', { hasText: 'query:' })).toHaveCount(0);
}

test.describe('smoke: 010-grounding-citations', () => {
  test('classic shell renders queries and sources as chrome', async ({ page }) => {
    await connectToMock(page, FIXTURE);
    await expectGroundingRendered(page.locator('#output-area'));
  });

  test('spatial shell renders queries and sources as chrome', async ({ page }) => {
    const screen = await openSpatialSession(page, FIXTURE);
    await expectGroundingRendered(screen);
  });
});
