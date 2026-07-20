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

// Unit tests for web/attach-core/protocol.js — the pure event-parsing
// helpers. Covers the same shape as client.test.js's demux cases, but
// against the standalone helper so the conformance harness (which
// exercises the helper directly, not via a client instance) has
// coverage of its own.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcProtocol = readFileSync(join(here, 'protocol.js'), 'utf8');

function loadProtocol() {
  new Function('window', srcProtocol)(globalThis);
  return globalThis.AttachCoreProtocol;
}

describe('AttachCoreProtocol', () => {
  let AttachCoreProtocol;
  beforeEach(() => {
    delete globalThis.AttachCoreProtocol;
    AttachCoreProtocol = loadProtocol();
  });

  describe('fanoutAgentFrame', () => {
    it('tolerates null / empty / malformed frames without throwing', () => {
      const emit = () => {
        throw new Error('should not emit');
      };
      expect(() => AttachCoreProtocol.fanoutAgentFrame(null, emit)).not.toThrow();
      expect(() => AttachCoreProtocol.fanoutAgentFrame({}, emit)).not.toThrow();
      expect(() => AttachCoreProtocol.fanoutAgentFrame({ event: null }, emit)).not.toThrow();
      expect(() => AttachCoreProtocol.fanoutAgentFrame({ event: {} }, emit)).not.toThrow();
      expect(() =>
        AttachCoreProtocol.fanoutAgentFrame({ event: { Content: {} } }, emit)
      ).not.toThrow();
    });

    it('emits multiple sub-events for a multi-part frame', () => {
      const events = [];
      AttachCoreProtocol.fanoutAgentFrame(
        {
          event: {
            Content: {
              parts: [
                { text: 'thinking...' },
                { functionCall: { id: 'c1', name: 'fs_read', args: {} } },
                {
                  functionResponse: {
                    id: 'c1',
                    name: 'fs_read',
                    response: { ok: true, latency_ms: 42 },
                  },
                },
              ],
            },
          },
        },
        (e) => events.push(e)
      );
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('stream-chunk');
      expect(events[1].type).toBe('tool-call');
      expect(events[2].type).toBe('tool-result');
      expect(events[2].data.latencyMs).toBe(42);
    });

    it('skips empty text parts (no stream-chunk for "")', () => {
      const events = [];
      AttachCoreProtocol.fanoutAgentFrame({ event: { Content: { parts: [{ text: '' }] } } }, (e) =>
        events.push(e)
      );
      expect(events).toEqual([]);
    });
  });

  describe('parseCapabilities', () => {
    it('returns null for non-object input', () => {
      expect(AttachCoreProtocol.parseCapabilities(null)).toBeNull();
      expect(AttachCoreProtocol.parseCapabilities(undefined)).toBeNull();
      expect(AttachCoreProtocol.parseCapabilities('capabilities')).toBeNull();
      expect(AttachCoreProtocol.parseCapabilities(42)).toBeNull();
    });

    it('passes through known and unknown fields verbatim (forward-compat)', () => {
      const raw = {
        protocol_version: '1.2.0',
        event_types: ['status-update', 'usage-update'],
        server: 'core-agent',
        // Fields that v1.3.0 will add — must survive round trip so
        // future client code can read them without a spec bump gate.
        features: { multi_session: true },
        slash_commands: ['compact'],
      };
      const parsed = AttachCoreProtocol.parseCapabilities(raw);
      expect(parsed).toEqual(raw);
      // Returns a copy — mutating the parsed result must not affect
      // the input.
      parsed.protocol_version = 'MUTATED';
      expect(raw.protocol_version).toBe('1.2.0');
    });
  });
});
