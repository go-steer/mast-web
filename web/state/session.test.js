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

// Unit tests for web/state/session.js — the sessionStore's shape +
// named actions. Verifies each action produces the expected state
// transition without touching neighboring fields.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcSubs = readFileSync(join(here, 'subscriptions.js'), 'utf8');
const srcSession = readFileSync(join(here, 'session.js'), 'utf8');

function loadSessionStore() {
  new Function('window', srcSubs)(globalThis);
  new Function('window', srcSession)(globalThis);
  return globalThis.MastState.createSession();
}

describe('state/session', () => {
  let session;
  beforeEach(() => {
    delete globalThis.MastState;
    session = loadSessionStore();
    session.store.reset();
  });

  it('initial state has expected shape', () => {
    const s = session.store.get();
    expect(s.capabilities).toBeNull();
    expect(s.status.turnState).toBe('idle');
    expect(s.usage.tokensIn).toBe(0);
    expect(s.usage.byModel).toEqual({});
    expect(s.usage.lastTurn).toBeNull();
    expect(s.sessions).toEqual([]);
    expect(s.costCeilingHit).toBe(false);
    expect(s.inboxState).toEqual({});
    expect(s.currentSession).toBe('');
    expect(s.serverSlashCommands).toEqual([]);
  });

  it('setCapabilities replaces the frame verbatim', () => {
    const frame = {
      protocol_version: '1.4.0',
      features: { multi_session: true },
      slash_commands: ['compact'],
    };
    session.setCapabilities(frame);
    expect(session.store.get().capabilities).toEqual(frame);
  });

  it('mergeCapabilities deep-merges features (v1.4.0 status-update path)', () => {
    session.setCapabilities({
      protocol_version: '1.4.0',
      features: { mcp: true, cost_ceiling: true, observer_mode: false },
      server: 'core-agent',
    });
    session.mergeCapabilities({ features: { mcp: false } });
    const caps = session.store.get().capabilities;
    // mcp flipped, other flags preserved
    expect(caps.features).toEqual({ mcp: false, cost_ceiling: true, observer_mode: false });
    // Non-features fields preserved from base
    expect(caps.protocol_version).toBe('1.4.0');
    expect(caps.server).toBe('core-agent');
  });

  it('mergeCapabilities handles the null-base case (no prior capabilities)', () => {
    session.mergeCapabilities({ features: { mcp: true } });
    expect(session.store.get().capabilities).toEqual({ features: { mcp: true } });
  });

  it('patchStatus merges into status without touching other fields', () => {
    session.patchStatus({ model: 'gemini-2.5-flash', turnState: 'streaming' });
    const s = session.store.get();
    expect(s.status.model).toBe('gemini-2.5-flash');
    expect(s.status.turnState).toBe('streaming');
    // Untouched:
    expect(s.status.provider).toBe('');
    expect(s.usage.tokensIn).toBe(0);
  });

  it('patchUsage merges into usage', () => {
    session.patchUsage({ tokensIn: 100, tokensOut: 50 });
    const s = session.store.get();
    expect(s.usage.tokensIn).toBe(100);
    expect(s.usage.tokensOut).toBe(50);
    expect(s.usage.turns).toBe(0);
  });

  it('setSessions replaces the sessions array', () => {
    session.setSessions([{ id: 'a' }, { id: 'b' }]);
    expect(session.store.get().sessions).toHaveLength(2);
    session.setSessions([{ id: 'c' }]);
    expect(session.store.get().sessions).toEqual([{ id: 'c' }]);
  });

  it('setCurrentSession + setCurrentModel + setTotalCostUSD write independently', () => {
    session.setCurrentSession('sess-1');
    session.setCurrentModel('gemini-2.5-flash');
    session.setTotalCostUSD(1.5);
    const s = session.store.get();
    expect(s.currentSession).toBe('sess-1');
    expect(s.currentModel).toBe('gemini-2.5-flash');
    expect(s.totalCostUSD).toBe(1.5);
  });

  it('incrementTurnCount adds 1 per call', () => {
    session.incrementTurnCount();
    session.incrementTurnCount();
    session.incrementTurnCount();
    expect(session.store.get().turnCount).toBe(3);
  });

  it('setCostCeilingHit flips the boolean', () => {
    session.setCostCeilingHit(true);
    expect(session.store.get().costCeilingHit).toBe(true);
    session.setCostCeilingHit(false);
    expect(session.store.get().costCeilingHit).toBe(false);
  });

  it('recordInbox stores the state under prompt_id', () => {
    session.recordInbox('p1', 'queued');
    session.recordInbox('p1', 'dequeued');
    session.recordInbox('p2', 'queued');
    const s = session.store.get();
    expect(s.inboxState).toEqual({ p1: 'dequeued', p2: 'queued' });
  });

  it('recordInbox ignores empty prompt_id (defensive)', () => {
    session.recordInbox('', 'queued');
    session.recordInbox(null, 'queued');
    expect(session.store.get().inboxState).toEqual({});
  });

  it('markInterruptUnsupported adds to the set without duplicating', () => {
    session.markInterruptUnsupported('s1');
    session.markInterruptUnsupported('s1');
    session.markInterruptUnsupported('s2');
    const arr = session.store.get().interruptUnsupportedForSession;
    expect(arr).toEqual(['s1', 's2']);
  });

  it('interruptUnsupportedFor returns true when the sid was marked', () => {
    session.markInterruptUnsupported('s1');
    expect(session.interruptUnsupportedFor('s1')).toBe(true);
    expect(session.interruptUnsupportedFor('s2')).toBe(false);
  });

  it('setServerSlashCommands replaces the array (defensive slice)', () => {
    const external = ['compact', 'done'];
    session.setServerSlashCommands(external);
    external.push('MUTATION');
    // Store's internal copy should be unaffected by the external mutation.
    expect(session.store.get().serverSlashCommands).toEqual(['compact', 'done']);
  });

  it('setServerSlashCommands with non-array normalizes to empty', () => {
    session.setServerSlashCommands(null);
    expect(session.store.get().serverSlashCommands).toEqual([]);
  });

  // ─── The pause gate (spec v1.5.0 §2.8 / v1.7.0 §2.9) ────────────────
  describe('pause gate', () => {
    const paused = {
      state: 'paused',
      reason: 'operator interrupt',
      interrupted: true,
      at: '2026-08-19T14:31:02.881Z',
    };

    it('applyPauseEvent records a park with its reason and interrupted flag', () => {
      session.applyPauseEvent(paused);
      expect(session.get().pause).toEqual({
        paused: true,
        since: '2026-08-19T14:31:02.881Z',
        reason: 'operator interrupt',
        interrupted: true,
        resumeMode: '',
      });
    });

    it('a plain /pause is not an interrupt', () => {
      // Absent `interrupted` means the gate closed without killing
      // anything — the difference between "your work was stopped" and
      // "the loop just will not start".
      session.applyPauseEvent({ state: 'paused', at: '2026-08-19T14:31:02Z' });
      expect(session.get().pause.interrupted).toBe(false);
      expect(session.get().pause.reason).toBe('');
    });

    it('applyPauseEvent clears the hold on resume and keeps the disposition', () => {
      session.applyPauseEvent(paused);
      session.applyPauseEvent({ state: 'resumed', mode: 'steer', at: '2026-08-19T14:32:44Z' });
      const p = session.get().pause;
      expect(p.paused).toBe(false);
      expect(p.since).toBe(null);
      expect(p.reason).toBe('');
      expect(p.interrupted).toBe(false);
      expect(p.resumeMode).toBe('steer');
    });

    it('ignores an unknown state rather than guessing', () => {
      // §2.8 reserves the right to add states and requires clients to
      // treat unknown ones as no-ops. Guessing is how a client breaks
      // on a minor bump it was supposed to survive.
      session.applyPauseEvent(paused);
      session.applyPauseEvent({ state: 'draining', at: '2026-08-19T14:33:00Z' });
      expect(session.get().pause.paused).toBe(true);
      expect(session.get().pause.reason).toBe('operator interrupt');
    });

    it('applyPauseStatus renders a hold that started before we attached', () => {
      // The whole reason the poll exists: a client attaching to an
      // already-paused session never sees the transition frame.
      session.applyPauseStatus({
        paused: true,
        paused_since: '2026-08-19T14:31:02Z',
        pause_reason: 'cost ceiling reached',
        interrupted: true,
      });
      expect(session.get().pause.paused).toBe(true);
      expect(session.get().pause.reason).toBe('cost ceiling reached');
    });

    it('a poll in flight across a resume does not flip the banner back on', () => {
      vi.useFakeTimers();
      try {
        session.applyPauseEvent(paused);
        session.applyPauseEvent({ state: 'resumed', mode: 'abandon', at: '2026-08-19T14:32:44Z' });
        // The server answered this poll before it processed the resume.
        session.applyPauseStatus({ paused: true, paused_since: '2026-08-19T14:31:02Z' });
        expect(session.get().pause.paused).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('but the server wins again once the settle window closes', () => {
      vi.useFakeTimers();
      try {
        session.applyPauseEvent({ state: 'resumed', mode: 'abandon', at: '2026-08-19T14:32:44Z' });
        vi.advanceTimersByTime(2500);
        // Not a stale poll any more — we missed an event, and a client
        // that keeps ignoring the server stays wrong forever.
        session.applyPauseStatus({ paused: true, paused_since: '2026-08-19T14:33:00Z' });
        expect(session.get().pause.paused).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('an agreeing poll applies immediately, window or not', () => {
      vi.useFakeTimers();
      try {
        session.applyPauseEvent({ state: 'paused', at: '2026-08-19T14:31:02Z' });
        session.applyPauseStatus({
          paused: true,
          paused_since: '2026-08-19T14:31:02Z',
          pause_reason: 'operator paused',
        });
        expect(session.get().pause.reason).toBe('operator paused');
      } finally {
        vi.useRealTimers();
      }
    });

    it('a pre-v1.5.0 status says nothing about pausing, which is not "running"', () => {
      // Absent is no answer. Overwriting observed state with it would
      // clear a banner the server never retracted.
      session.applyPauseEvent(paused);
      session.applyPauseStatus({ model: 'gemini-2.5-flash', provider: 'vertex' });
      expect(session.get().pause.paused).toBe(true);
    });

    it('falls back to turn_state when a status omits the explicit flag', () => {
      session.applyPauseStatus({ turn_state: 'paused' });
      expect(session.get().pause.paused).toBe(true);
      session.applyPauseStatus({ turn_state: 'idle' });
      expect(session.get().pause.paused).toBe(false);
    });

    it('recordWake stores the timestamp and asserts nothing about the inbox', () => {
      // §2.9: a wake does NOT mean an alert is waiting. Whatever did
      // the waking announces itself through its own frames, so the
      // store must not synthesize inbox state from one.
      session.recordWake('2026-08-19T14:32:05.117Z');
      expect(session.get().lastWakeAt).toBe('2026-08-19T14:32:05.117Z');
      expect(session.get().inboxState).toEqual({});
    });

    it('a wake is an edge, not a state — it does not touch the gate', () => {
      session.applyPauseEvent(paused);
      session.recordWake('2026-08-19T14:32:05.117Z');
      expect(session.get().pause.paused).toBe(true);
    });
  });
});

// v0.4: the module exports a factory and nothing else. A room full of
// terminals needs each one to hold its own state, and the shared
// instance the classic shell reached for went with it in #61.
describe('state/session — factory', () => {
  let createSession;
  beforeEach(() => {
    delete globalThis.MastState;
    loadSessionStore();
    createSession = globalThis.MastState.createSession;
  });

  it('instances do not share state', () => {
    const a = createSession();
    const b = createSession();
    a.setCurrentSession('s-a');
    a.setCurrentModel('opus');
    expect(b.get().currentSession).toBe('');
    expect(b.get().currentModel).toBe('');
  });

  it('opts seed the initial state, and reset() returns to that seed', () => {
    const s = createSession({ endpoint: 'https://a', label: 'alpha', currentSession: 's1' });
    expect(s.get().endpoint).toBe('https://a');
    expect(s.get().label).toBe('alpha');
    s.setLabel('renamed');
    s.store.reset();
    expect(s.get().label).toBe('alpha');
    expect(s.get().currentSession).toBe('s1');
  });

  it('turn counting is per instance', () => {
    const a = createSession();
    const b = createSession();
    a.incrementTurnCount();
    a.incrementTurnCount();
    b.setTurnCount(9);
    expect(a.get().turnCount).toBe(2);
    expect(b.get().turnCount).toBe(9);
  });

  it('subscribe fires only for its own instance', () => {
    const a = createSession();
    const b = createSession();
    let hitsA = 0;
    let hitsB = 0;
    a.subscribe(() => hitsA++);
    b.subscribe(() => hitsB++);
    a.setEndpoint('https://a');
    expect(hitsA).toBe(1);
    expect(hitsB).toBe(0);
  });

  // The factory is the whole export surface. A stray singleton here is
  // how a shell accidentally shares one session's state with another,
  // which is the bug the factory exists to make impossible.
  it('exports no shared instance', () => {
    expect(globalThis.MastState.session).toBeUndefined();
  });

  // ─── whoami (PR 2 / #59) ───────────────────────────────────────────

  describe('setWhoami', () => {
    it('starts null and stores the resolved identity', () => {
      const st = createSession();
      expect(st.get().whoami).toBeNull();
      st.setWhoami({ identity: 'ada@example.com', source: 'bearer', admin: true });
      expect(st.get().whoami).toEqual({
        identity: 'ada@example.com',
        source: 'bearer',
        admin: true,
      });
    });

    // "We asked and got nothing" has to read the same as "we never
    // asked" — both mean there is no identity to show, and a consumer
    // that has to tell {} from null to find that out will get it wrong.
    it('normalizes an answer with no identity to null', () => {
      const st = createSession();
      st.setWhoami({ identity: 'ada@example.com' });
      st.setWhoami({});
      expect(st.get().whoami).toBeNull();
      st.setWhoami({ identity: 'ada@example.com' });
      st.setWhoami(null);
      expect(st.get().whoami).toBeNull();
      st.setWhoami({ identity: 'ada@example.com' });
      st.setWhoami('ada');
      expect(st.get().whoami).toBeNull();
    });

    it('is per-instance', () => {
      const a = createSession();
      const b = createSession();
      a.setWhoami({ identity: 'ada@example.com' });
      expect(b.get().whoami).toBeNull();
    });
  });
});
