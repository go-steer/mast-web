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

  it('exports ReplayHistory + stripInboxWrapper', () => {
    expect(AttachCoreReplay.ReplayHistory).toBeDefined();
    expect(typeof AttachCoreReplay.stripInboxWrapper).toBe('function');
    expect(AttachCoreReplay.DEFAULT_MAX_EVENTS).toBe(2000);
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

  describe('ReplayHistory', () => {
    // The wire shapes the buffer groups on: a user-authored chunk is a
    // backend prompt echo and starts a turn, everything else continues
    // the one in progress.
    const prompt = (text) => ({ type: 'stream-chunk', data: { text, author: 'user' } });
    const reply = (text) => ({ type: 'stream-chunk', data: { text, author: 'core_agent' } });

    function seed(h, turns) {
      for (let i = 0; i < turns; i += 1) {
        h.push(prompt('q' + i));
        h.push(reply('a' + i));
      }
      return h;
    }

    it('groups events into turns on the prompt echo', () => {
      const h = seed(new AttachCoreReplay.ReplayHistory({}), 3);
      expect(h.turnCount).toBe(3);
      expect(h.eventCount).toBe(6);
    });

    it('opens a turn for events that arrive before any prompt echo', () => {
      // An autonomous run, or a log whose first prompt fell off the
      // front: the events still have to go somewhere.
      const h = new AttachCoreReplay.ReplayHistory({});
      h.push(reply('mid-thought'));
      h.push(prompt('q'));
      expect(h.turnCount).toBe(2);
      expect(h._groups[0].events).toHaveLength(1);
    });

    it('newest(n) hands back the n most recent turns, oldest first', () => {
      const h = seed(new AttachCoreReplay.ReplayHistory({}), 5);
      const turns = h.newest(2);
      expect(turns).toHaveLength(2);
      expect(turns[0].events[0].data.text).toBe('q3');
      expect(turns[1].events[0].data.text).toBe('q4');
      expect(h.olderCount).toBe(3);
    });

    it('newest(n) is capped by what there is', () => {
      const h = seed(new AttachCoreReplay.ReplayHistory({}), 2);
      expect(h.newest(10)).toHaveLength(2);
      expect(h.olderCount).toBe(0);
    });

    it('earlier(n) walks backwards without repeating itself', () => {
      const h = seed(new AttachCoreReplay.ReplayHistory({}), 6);
      h.newest(1);
      expect(h.earlier(2).map((t) => t.events[0].data.text)).toEqual(['q3', 'q4']);
      expect(h.olderCount).toBe(3);
      expect(h.earlier(2).map((t) => t.events[0].data.text)).toEqual(['q1', 'q2']);
      expect(h.earlier(2).map((t) => t.events[0].data.text)).toEqual(['q0']);
      expect(h.olderCount).toBe(0);
      expect(h.earlier(2)).toEqual([]);
    });

    it('a straggler after the window opens a new turn rather than reopening a drawn one', () => {
      const h = seed(new AttachCoreReplay.ReplayHistory({}), 2);
      h.newest(2);
      h.push(reply('late'));
      expect(h.turnCount).toBe(3);
    });

    it('drops the oldest turns past the cap and admits it', () => {
      const h = new AttachCoreReplay.ReplayHistory({ maxEvents: 4 });
      seed(h, 3); // 6 events
      expect(h.truncated).toBe(true);
      expect(h.eventCount).toBeLessThanOrEqual(4);
      expect(h.newest(10).map((t) => t.events[0].data.text)).toEqual(['q1', 'q2']);
    });

    it('keeps one turn however long it is — a single turn is still the whole log', () => {
      const h = new AttachCoreReplay.ReplayHistory({ maxEvents: 2 });
      h.push(prompt('q'));
      h.push(reply('a'));
      h.push(reply('b'));
      h.push(reply('c'));
      expect(h.turnCount).toBe(1);
      expect(h.eventCount).toBe(4);
      expect(h.truncated).toBe(false);
    });

    it('is empty until pushed to', () => {
      const h = new AttachCoreReplay.ReplayHistory({});
      expect(h.newest(3)).toEqual([]);
      expect(h.earlier(3)).toEqual([]);
      expect(h.truncated).toBe(false);
      h.push(null);
      expect(h.turnCount).toBe(0);
    });
  });

  describe('stripInboxWrapper', () => {
    const strip = (s) => loadReplay().stripInboxWrapper(s);

    it('unwraps the delivery envelope a real backend echoes', () => {
      expect(strip('[Inbox]\n- what is the capital of Portugal?\n\n---\n\n')).toBe(
        'what is the capital of Portugal?'
      );
    });

    it('keeps every line of a multi-prompt inbox', () => {
      expect(strip('[Inbox]\n- first\n- second\n\n---\n\nignored tail')).toBe('first\nsecond');
    });

    it('passes unwrapped text through, trimmed', () => {
      expect(strip('  plain prompt\n')).toBe('plain prompt');
      expect(strip('')).toBe('');
      expect(strip(undefined)).toBe('');
    });

    it('leaves text that only looks like the envelope alone', () => {
      expect(strip('[Inbox] is a great band')).toBe('[Inbox] is a great band');
    });
  });
});
