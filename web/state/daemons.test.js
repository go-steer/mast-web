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

// Unit tests for web/state/daemons.js — the multi-daemon registry
// added in v0.3.0 PR 2 (mast-web#22).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcSubs = readFileSync(join(here, 'subscriptions.js'), 'utf8');
const srcDaemons = readFileSync(join(here, 'daemons.js'), 'utf8');

function loadDaemonsStore() {
  new Function('window', srcSubs)(globalThis);
  new Function('window', srcDaemons)(globalThis);
  return globalThis.MastState.daemons;
}

describe('state/daemons', () => {
  let d;
  beforeEach(() => {
    delete globalThis.MastState;
    d = loadDaemonsStore();
    d.store.reset();
  });

  it('initial state is an empty registry', () => {
    const s = d.store.get();
    expect(s.daemons).toEqual({});
    expect(s.activeDaemon).toBe('');
  });

  it('addDaemon upserts by endpoint + preserves addedAt on re-add', () => {
    d.addDaemon({ endpoint: 'https://a', token: 't1', addedAt: '2026-01-01T00:00:00Z' });
    d.addDaemon({ endpoint: 'https://a', token: 't2', alias: 'alpha' });
    const rec = d.getDaemon('https://a');
    expect(rec.token).toBe('t2');
    expect(rec.alias).toBe('alpha');
    expect(rec.addedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('patchDaemon updates in place + is a no-op for unknown endpoints', () => {
    d.addDaemon({ endpoint: 'https://a', state: 'connecting' });
    d.patchDaemon('https://a', { state: 'connected' });
    expect(d.getDaemon('https://a').state).toBe('connected');
    d.patchDaemon('https://never', { state: 'connected' });
    expect(d.getDaemon('https://never')).toBeNull();
  });

  it('removeDaemon drops the entry and hands off activeDaemon', () => {
    d.addDaemon({ endpoint: 'https://a', addedAt: '2026-01-01T00:00:00Z' });
    d.addDaemon({ endpoint: 'https://b', addedAt: '2026-01-02T00:00:00Z' });
    d.setActiveDaemon('https://a');
    d.removeDaemon('https://a');
    expect(d.getDaemon('https://a')).toBeNull();
    expect(d.store.get().activeDaemon).toBe('https://b');
  });

  it('removeDaemon of a non-active daemon leaves activeDaemon untouched', () => {
    d.addDaemon({ endpoint: 'https://a', addedAt: '2026-01-01T00:00:00Z' });
    d.addDaemon({ endpoint: 'https://b', addedAt: '2026-01-02T00:00:00Z' });
    d.setActiveDaemon('https://a');
    d.removeDaemon('https://b');
    expect(d.store.get().activeDaemon).toBe('https://a');
  });

  it('removeDaemon of the last daemon clears activeDaemon', () => {
    d.addDaemon({ endpoint: 'https://a' });
    d.setActiveDaemon('https://a');
    d.removeDaemon('https://a');
    expect(d.store.get().activeDaemon).toBe('');
  });

  it('listDaemons returns entries in addedAt order', () => {
    d.addDaemon({ endpoint: 'https://c', addedAt: '2026-03-01T00:00:00Z' });
    d.addDaemon({ endpoint: 'https://a', addedAt: '2026-01-01T00:00:00Z' });
    d.addDaemon({ endpoint: 'https://b', addedAt: '2026-02-01T00:00:00Z' });
    expect(d.listDaemons().map((x) => x.endpoint)).toEqual(['https://a', 'https://b', 'https://c']);
  });

  it('listDaemons breaks addedAt ties by endpoint for determinism', () => {
    d.addDaemon({ endpoint: 'https://b', addedAt: '2026-01-01T00:00:00Z' });
    d.addDaemon({ endpoint: 'https://a', addedAt: '2026-01-01T00:00:00Z' });
    expect(d.listDaemons().map((x) => x.endpoint)).toEqual(['https://a', 'https://b']);
  });

  it('getActiveDaemon returns null when no active daemon is set', () => {
    d.addDaemon({ endpoint: 'https://a' });
    expect(d.getActiveDaemon()).toBeNull();
    d.setActiveDaemon('https://a');
    expect(d.getActiveDaemon().endpoint).toBe('https://a');
  });

  it('setActiveDaemon(empty) clears the active pointer', () => {
    d.addDaemon({ endpoint: 'https://a' });
    d.setActiveDaemon('https://a');
    d.setActiveDaemon('');
    expect(d.store.get().activeDaemon).toBe('');
  });
});
