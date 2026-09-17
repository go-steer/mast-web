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

  // The two-question split from spec §2.8. These are the helpers that
  // decide whether a shell renders a pause banner and whether it offers
  // a Pause button, and the interesting cases are all the ones where
  // the honest answer to the two questions differs.
  describe('emitsEvent / hasFeature', () => {
    const v17 = {
      protocol_version: '1.7.0',
      event_types: ['capabilities', 'status-update', 'pause', 'wake'],
      features: { interrupt: true, pause: true },
    };

    it('reads event_types for what the stream will carry', () => {
      expect(AttachCoreProtocol.emitsEvent(v17, 'pause')).toBe(true);
      expect(AttachCoreProtocol.emitsEvent(v17, 'wake')).toBe(true);
      expect(AttachCoreProtocol.emitsEvent(v17, 'inbox')).toBe(false);
    });

    it('assumes the classic set, and only that, when event_types is absent', () => {
      // A pre-v1.1.0 server never declared one. Rendering nothing at
      // all would be worse than assuming the events that predate the
      // field — but nothing newer may be assumed.
      const bare = { protocol_version: '1.0.0', server: 'core-agent' };
      expect(AttachCoreProtocol.emitsEvent(bare, 'status-update')).toBe(true);
      expect(AttachCoreProtocol.emitsEvent(bare, 'agent')).toBe(true);
      expect(AttachCoreProtocol.emitsEvent(bare, 'pause')).toBe(false);
      expect(AttachCoreProtocol.emitsEvent(bare, 'wake')).toBe(false);
    });

    it('answers no for a null capabilities frame', () => {
      // Null means the server hasn't advertised yet, not that it can't
      // do anything — but before the first frame there is nothing to
      // render, so no is the safe read.
      expect(AttachCoreProtocol.emitsEvent(null, 'pause')).toBe(false);
    });

    it('reads features for what the backend will accept', () => {
      expect(AttachCoreProtocol.hasFeature(v17, 'pause')).toBe(true);
      expect(AttachCoreProtocol.hasFeature({ features: { pause: false } }, 'pause')).toBe(false);
    });

    it('treats an absent feature key as on, per the §2.1 additive rule', () => {
      // A producer that predates a flag stays silent about it. Reading
      // that silence as "off" would switch off working features on
      // every older backend each time the spec grows one — and it is
      // what the shells already assume: absent reads as on.
      expect(AttachCoreProtocol.hasFeature({ features: { pause: true } }, 'guardrails')).toBe(true);
      expect(AttachCoreProtocol.hasFeature({ protocol_version: '1.2.0' }, 'pause')).toBe(true);
      expect(AttachCoreProtocol.hasFeature(null, 'pause')).toBe(true);
    });

    it('gives different answers to the two questions for the same frame', () => {
      // The case the spec calls out by name: a server that speaks the
      // frame but sits in front of an agent that cannot hold. Read only
      // event_types and you offer a button the server will reject; read
      // only features and you ignore a pause somebody else caused.
      const speaksButCannotHold = {
        event_types: ['capabilities', 'pause'],
        features: { pause: false },
      };
      expect(AttachCoreProtocol.emitsEvent(speaksButCannotHold, 'pause')).toBe(true);
      expect(AttachCoreProtocol.hasFeature(speaksButCannotHold, 'pause')).toBe(false);
    });
  });

  // The third question, added at v1.10.0: "does this endpoint exist?"
  // Neither helper above can answer it. event_types is about frames,
  // features is about flags, and the ACL and title routes have no flag
  // — checked in core-agent's events.go, not assumed.
  describe('protocolAtLeast', () => {
    const at = (v, want) => AttachCoreProtocol.protocolAtLeast({ protocol_version: v }, want);

    it('compares components numerically, not as strings', () => {
      // The bug this function exists to not have: '1.10.0' < '1.7.0'
      // lexicographically, so a string compare would hide every
      // v1.10.0 endpoint on exactly the servers that have them.
      expect('1.10.0' < '1.7.0').toBe(true);
      expect(at('1.10.0', '1.7.0')).toBe(true);
      expect(at('1.12.0', '1.10.0')).toBe(true);
      expect(at('1.9.0', '1.10.0')).toBe(false);
    });

    it('is inclusive of the version asked for', () => {
      expect(at('1.10.0', '1.10.0')).toBe(true);
    });

    it('reads a short version as zero-filled', () => {
      // core-agent has shipped two-component strings. '1.10' is 1.10.0,
      // not something less than it.
      expect(at('1.10', '1.10.0')).toBe(true);
      expect(at('2', '1.12.0')).toBe(true);
    });

    it('answers NO when it cannot tell — the opposite default from hasFeature', () => {
      // hasFeature reads silence as yes, because a producer that
      // predates a flag still has the feature. Here silence means a
      // server too old to have said, and calling an endpoint that
      // isn't there is a 404 in the operator's face. The two defaults
      // disagree on purpose.
      expect(AttachCoreProtocol.protocolAtLeast(null, '1.10.0')).toBe(false);
      expect(AttachCoreProtocol.protocolAtLeast({}, '1.10.0')).toBe(false);
      expect(at('', '1.10.0')).toBe(false);
      expect(at('v1.12.0', '1.10.0')).toBe(false);
      expect(at('1.x.0', '1.10.0')).toBe(false);
      expect(at('1.2.3.4', '1.10.0')).toBe(false);
      expect(AttachCoreProtocol.protocolAtLeast({ protocol_version: 112 }, '1.10.0')).toBe(false);
    });

    it('tolerates the surrounding whitespace a hand-edited fixture picks up', () => {
      expect(at(' 1.12.0 ', '1.10.0')).toBe(true);
    });
  });
});
