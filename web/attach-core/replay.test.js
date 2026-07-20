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

// Unit tests for web/attach-core/replay.js.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcReplay = readFileSync(join(here, 'replay.js'), 'utf8');

function loadReplay() {
  new Function('window', srcReplay)(globalThis);
  return globalThis.AttachCoreReplay;
}

describe('AttachCoreReplay', () => {
  let AttachCoreReplay;
  beforeEach(() => {
    delete globalThis.AttachCoreReplay;
    AttachCoreReplay = loadReplay();
  });

  it('exports ReplayFilter + DEFAULT_REPLAY_GRACE_MS', () => {
    expect(AttachCoreReplay.ReplayFilter).toBeDefined();
    expect(AttachCoreReplay.DEFAULT_REPLAY_GRACE_MS).toBe(2000);
  });

  describe('ReplayFilter', () => {
    it('classifies old timestamps as replay (older than cutoff)', () => {
      const connectedAt = 1_000_000; // ms epoch (arbitrary)
      const f = new AttachCoreReplay.ReplayFilter({ connectedAt, graceMs: 500 });
      // Cutoff = 999_500. Anything before that is replay.
      expect(f.isReplay(999_499)).toBe(true);
      expect(f.isReplay(500_000)).toBe(true);
    });

    it('classifies fresh timestamps as live (equal-or-newer than cutoff)', () => {
      const connectedAt = 1_000_000;
      const f = new AttachCoreReplay.ReplayFilter({ connectedAt, graceMs: 500 });
      // Cutoff = 999_500. At-or-after is live.
      expect(f.isReplay(999_500)).toBe(false);
      expect(f.isReplay(1_000_000)).toBe(false);
      expect(f.isReplay(1_000_500)).toBe(false);
    });

    it('accepts ISO-8601 string timestamps (server default JSON shape)', () => {
      const connectedAt = Date.parse('2026-07-20T12:00:00Z');
      const f = new AttachCoreReplay.ReplayFilter({ connectedAt, graceMs: 2000 });
      // Cutoff = 12:00:00 - 2s = 11:59:58Z
      expect(f.isReplay('2026-07-20T11:59:57Z')).toBe(true);
      expect(f.isReplay('2026-07-20T11:59:58Z')).toBe(false);
      expect(f.isReplay('2026-07-20T12:00:05Z')).toBe(false);
    });

    it('fails open on missing / unparseable timestamps (never drops)', () => {
      const f = new AttachCoreReplay.ReplayFilter({ connectedAt: 1_000_000, graceMs: 500 });
      expect(f.isReplay(null)).toBe(false);
      expect(f.isReplay(undefined)).toBe(false);
      expect(f.isReplay('not a date')).toBe(false);
      expect(f.isReplay({})).toBe(false);
    });

    it('defaults graceMs to 2000 (matches coretuiremote replayGrace)', () => {
      const f = new AttachCoreReplay.ReplayFilter({ connectedAt: 1_000_000 });
      expect(f.graceMs).toBe(2000);
      // Cutoff = 998_000
      expect(f.isReplay(997_999)).toBe(true);
      expect(f.isReplay(998_000)).toBe(false);
    });

    it('defaults connectedAt to current wall clock when omitted', () => {
      const before = Number(new Date());
      const f = new AttachCoreReplay.ReplayFilter({});
      const after = Number(new Date());
      expect(f.connectedAt).toBeGreaterThanOrEqual(before);
      expect(f.connectedAt).toBeLessThanOrEqual(after);
    });

    describe('extractAgentFrameTimestamp', () => {
      it('reads PascalCase Timestamp', () => {
        const ts = AttachCoreReplay.ReplayFilter.extractAgentFrameTimestamp({
          event: { Timestamp: '2026-07-20T12:00:00Z' },
        });
        expect(ts).toBe('2026-07-20T12:00:00Z');
      });

      it('reads camelCase timestamp', () => {
        const ts = AttachCoreReplay.ReplayFilter.extractAgentFrameTimestamp({
          event: { timestamp: '2026-07-20T12:00:00Z' },
        });
        expect(ts).toBe('2026-07-20T12:00:00Z');
      });

      it('returns null on missing / malformed frames', () => {
        expect(AttachCoreReplay.ReplayFilter.extractAgentFrameTimestamp(null)).toBeNull();
        expect(AttachCoreReplay.ReplayFilter.extractAgentFrameTimestamp({})).toBeNull();
        expect(AttachCoreReplay.ReplayFilter.extractAgentFrameTimestamp({ event: {} })).toBeNull();
      });
    });
  });
});
