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

// Conformance test — iterates every fixture pair under fixtures/ and
// asserts that feeding the frames through AttachCoreProtocol produces
// the expected typed-event stream.
//
// Adding a fixture is a two-file drop under fixtures/; the test picks
// it up automatically. See README.md for the fixture-pair contract.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

import { runFixture, parseJSONL } from './runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');
const srcProtocol = readFileSync(join(here, '..', 'protocol.js'), 'utf8');

function loadProtocol() {
  new Function('window', srcProtocol)(globalThis);
  return globalThis.AttachCoreProtocol;
}

// Discover fixture pairs at import time so vitest's describe/it can
// register one test per fixture (better failure attribution than a
// single it() with a for-loop inside).
function discoverFixtures() {
  const files = readdirSync(fixturesDir);
  const fixtureNames = new Set();
  for (const f of files) {
    const m = f.match(/^(.+)\.jsonl$/);
    if (m) fixtureNames.add(m[1]);
  }
  const out = [];
  for (const name of Array.from(fixtureNames).sort()) {
    const jsonlPath = join(fixturesDir, `${name}.jsonl`);
    const expectedPath = join(fixturesDir, `${name}.expected.json`);
    out.push({ name, jsonlPath, expectedPath });
  }
  return out;
}

const fixtures = discoverFixtures();

describe('attach-core conformance', () => {
  let protocol;
  beforeEach(() => {
    delete globalThis.AttachCoreProtocol;
    protocol = loadProtocol();
  });

  it('discovered at least one fixture pair', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { name, jsonlPath, expectedPath } of fixtures) {
    it(`${name} — observed matches expected`, () => {
      const framesText = readFileSync(jsonlPath, 'utf8');
      const expectedText = readFileSync(expectedPath, 'utf8');
      const frames = parseJSONL(framesText);
      const expected = JSON.parse(expectedText);

      const observed = runFixture(frames, protocol);

      // Full array equality — order matters (spec §2 ordering).
      expect(observed).toEqual(expected);
    });
  }
});
