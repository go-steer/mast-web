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

// v0.4: web/agents.js's half of the registry — persistence, add,
// refresh, discovery — folded in here. The sidebar it also drew is
// web/daemon-sidebar.js and is not exercised from this file, because
// nothing in state/ touches the DOM.
describe('state/daemons — registry operations', () => {
  let createDaemons;
  let clients;

  // A stand-in for AttachClient: one per registered endpoint, with the
  // two calls the registry makes.
  function makeStubClient(rec) {
    const client = {
      endpoint: rec.endpoint,
      token: rec.token,
      sessions: [{ id: 's1', app: 'demo' }],
      listCalls: 0,
      fail: null,
      async listSessions() {
        this.listCalls++;
        if (this.fail) throw this.fail;
        return this.sessions;
      },
      async createSession() {
        if (this.fail) throw this.fail;
        return { id: 's2', app: 'demo', user: 'ada' };
      },
      deleted: [],
      async deleteSession(app, sid) {
        if (this.fail) throw this.fail;
        this.deleted.push([app, sid]);
      },
    };
    clients.set(rec.endpoint, client);
    return client;
  }

  function registry() {
    return createDaemons({ makeClient: makeStubClient });
  }

  beforeEach(() => {
    delete globalThis.MastState;
    delete globalThis.AttachClient;
    localStorage.clear();
    clients = new Map();
    new Function('window', srcSubs)(globalThis);
    new Function('window', srcDaemons)(globalThis);
    createDaemons = globalThis.MastState.createDaemons;
  });

  it('instances do not share a registry', () => {
    const a = registry();
    const b = registry();
    a.add('https://a');
    expect(b.listDaemons()).toEqual([]);
  });

  it('add normalizes the endpoint and builds a client', () => {
    const r = registry();
    const rec = r.add('https://a///', 'tok');
    expect(rec.endpoint).toBe('https://a');
    expect(rec.alias).toBe('a');
    expect(rec.state).toBe('connecting');
    expect(rec.client).toBe(clients.get('https://a'));
  });

  it('re-adding a known endpoint returns the existing record, client and all', () => {
    const r = registry();
    const first = r.add('https://a', 'tok');
    const again = r.add('https://a/', 'other-token');
    // Same client object: a second attach-form submission must not
    // orphan the AttachClient this daemon's terminals already hold.
    expect(again.client).toBe(first.client);
    expect(again.token).toBe('tok');
  });

  it('add persists chosen rows and skips derived ones', () => {
    const r = registry();
    r.add('https://a', 'tok');
    r.add('https://derived', '', { derived: true });
    const rows = JSON.parse(localStorage.getItem('mast-web:daemons'));
    expect(rows.map((x) => x.endpoint)).toEqual(['https://a']);
    expect(rows[0].token).toBe('tok');
  });

  it('remove drops the record and rewrites storage', () => {
    const r = registry();
    r.add('https://a');
    r.add('https://b');
    r.remove('https://a');
    expect(r.getDaemon('https://a')).toBeNull();
    expect(JSON.parse(localStorage.getItem('mast-web:daemons')).map((x) => x.endpoint)).toEqual([
      'https://b',
    ]);
  });

  it('refresh lists sessions and resolves with the post-list record', async () => {
    const r = registry();
    const stale = r.add('https://a');
    const fresh = await r.refresh(stale);
    expect(fresh.state).toBe('connected');
    expect(fresh.sessions).toEqual([{ id: 's1', app: 'demo' }]);
    // The record handed in is a pre-list snapshot — which is exactly
    // why refresh resolves with a new one rather than mutating it.
    expect(stale.sessions).toEqual([]);
  });

  it('refresh records the failure on the daemon rather than throwing', async () => {
    const r = registry();
    r.add('https://a');
    clients.get('https://a').fail = new Error('connection refused');
    const fresh = await r.refresh('https://a');
    expect(fresh.state).toBe('error');
    expect(fresh.lastError).toBe('connection refused');
    expect(fresh.sessions).toEqual([]);
  });

  it('refresh of an unregistered endpoint resolves null', async () => {
    expect(await registry().refresh('https://never')).toBeNull();
  });

  it('refreshAll lists every registered daemon once', async () => {
    const r = registry();
    r.add('https://a');
    r.add('https://b');
    await r.refreshAll();
    expect(clients.get('https://a').listCalls).toBe(1);
    expect(clients.get('https://b').listCalls).toBe(1);
    expect(r.getDaemon('https://b').state).toBe('connected');
  });

  it('newSession creates, re-lists, and returns the new row', async () => {
    const r = registry();
    r.add('https://a');
    const s = await r.newSession('https://a');
    expect(s).toEqual({ id: 's2', app: 'demo', user: 'ada', status: 'active' });
    expect(clients.get('https://a').listCalls).toBe(1);
  });

  it('newSession returns null and records the error on failure', async () => {
    const r = registry();
    r.add('https://a');
    clients.get('https://a').fail = new Error('no capacity');
    expect(await r.newSession('https://a')).toBeNull();
    expect(r.getDaemon('https://a').lastError).toBe('no capacity');
  });

  // A sidebar button is the only caller, so every one of these resolves
  // with { ok, error } rather than throwing: the operator needs to read
  // the reason, not have the shell fall over on it.
  describe('deleteSession', () => {
    async function withSession() {
      const r = registry();
      r.add('https://a');
      await r.refresh('https://a');
      return r;
    }

    it('deletes app-qualified and drops the row without re-listing', async () => {
      const r = await withSession();
      const before = clients.get('https://a').listCalls;
      expect(await r.deleteSession('https://a', 's1')).toEqual({ ok: true, error: '' });
      // Qualified, because the unqualified shortcut 409s when two
      // tenants have a session of the same name.
      expect(clients.get('https://a').deleted).toEqual([['demo', 's1']]);
      expect(r.getDaemon('https://a').sessions).toEqual([]);
      // A refresh here would repaint the whole group for one row.
      expect(clients.get('https://a').listCalls).toBe(before);
    });

    it('takes a row object as readily as an id', async () => {
      const r = await withSession();
      const row = r.getDaemon('https://a').sessions[0];
      expect((await r.deleteSession('https://a', row)).ok).toBe(true);
      expect(clients.get('https://a').deleted).toEqual([['demo', 's1']]);
    });

    it('refuses an unattached daemon', async () => {
      const r = registry();
      expect(await r.deleteSession('https://never', 's1')).toEqual({
        ok: false,
        error: 'daemon https://never is not attached',
      });
    });

    // The app qualifier comes out of the last listing, so a row that
    // isn't in it has no qualifier to send.
    it('refuses a session that is not in the listing', async () => {
      const r = await withSession();
      const res = await r.deleteSession('https://a', 's9');
      expect(res.ok).toBe(false);
      expect(res.error).toContain('refresh first');
    });

    // core-agent 403s on it — it is what the daemon falls back to — so
    // there is no point spending a round trip to learn that.
    it('refuses the bootstrap session without asking the server', async () => {
      const r = registry();
      r.add('https://a');
      clients.get('https://a').sessions = [{ id: 'default', app: 'demo' }];
      await r.refresh('https://a');
      const res = await r.deleteSession('https://a', 'default');
      expect(res.ok).toBe(false);
      expect(res.error).toContain('bootstrap');
      expect(clients.get('https://a').deleted).toEqual([]);
    });

    it('relays a server refusal and keeps the row', async () => {
      const r = await withSession();
      clients.get('https://a').fail = new Error('session is running');
      expect(await r.deleteSession('https://a', 's1')).toEqual({
        ok: false,
        error: 'session is running',
      });
      expect(r.getDaemon('https://a').sessions).toHaveLength(1);
    });
  });

  it('discover prefers stored rows and never asks the server', async () => {
    localStorage.setItem(
      'mast-web:daemons',
      JSON.stringify([{ endpoint: 'https://chosen', token: 't' }])
    );
    let asked = false;
    globalThis.AttachClient = {
      discoverConfig: async () => {
        asked = true;
        return { endpoint: '/attach' };
      },
    };
    const found = await registry().discover();
    expect(asked).toBe(false);
    expect(found).toEqual({ rows: [{ endpoint: 'https://chosen', token: 't' }], derived: false });
  });

  it('discover falls back to the legacy single-entry key', async () => {
    localStorage.setItem('mast-web:config', JSON.stringify({ endpoint: 'https://legacy' }));
    const found = await registry().discover();
    expect(found.derived).toBe(false);
    expect(found.rows[0].endpoint).toBe('https://legacy');
  });

  it('discover asks GET /config when nothing is stored, and caches it on site()', async () => {
    globalThis.AttachClient = {
      discoverConfig: async () => ({ endpoint: '/attach', mode: 'bff' }),
    };
    const r = registry();
    expect(r.site()).toBeNull();
    const found = await r.discover();
    expect(found).toEqual({ rows: [{ endpoint: '/attach', token: '' }], derived: true });
    expect(r.site().mode).toBe('bff');
  });

  it('discover falls back to same-origin when /config names no endpoint', async () => {
    globalThis.AttachClient = { discoverConfig: async () => ({ mode: 'mock' }) };
    const found = await registry().discover();
    expect(found.rows[0].endpoint).toBe('/');
  });

  it('daemonMap is a snapshot in registry order', () => {
    const r = registry();
    r.addDaemon({ endpoint: 'https://b', addedAt: '2026-02-01T00:00:00Z' });
    r.addDaemon({ endpoint: 'https://a', addedAt: '2026-01-01T00:00:00Z' });
    const m = r.daemonMap();
    expect([...m.keys()]).toEqual(['https://a', 'https://b']);
    m.delete('https://a');
    expect(r.getDaemon('https://a')).not.toBeNull();
  });

  it('subscribe fires on registry mutations', () => {
    const r = registry();
    let hits = 0;
    r.subscribe(() => hits++);
    r.add('https://a');
    r.setActiveDaemon('https://a');
    expect(hits).toBe(2);
  });
});
