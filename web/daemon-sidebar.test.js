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

// Unit tests for web/daemon-sidebar.js's delete gesture (PR 3b, #60).
//
// The rest of the module is a repaint of the registry and is covered by
// the smoke suite, which can see it. What is worth asserting faster
// than Playwright is the part that can destroy something: that it asks
// first, that a "no" stops there, that a refusal is shown rather than
// swallowed, and that the shell is told only once the server has
// actually agreed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const load = (rel) => new Function('window', readFileSync(join(here, rel), 'utf8'))(globalThis);

describe('MastDaemonSidebar — the delete gesture', () => {
  let clients;
  let listEl;

  function makeStubClient(rec) {
    const client = {
      endpoint: rec.endpoint,
      sessions: [
        { id: 's1', app: 'demo', title: 'ops triage' },
        { id: 'default', app: 'demo' },
      ],
      fail: null,
      deleted: [],
      async listSessions() {
        return this.sessions;
      },
      async deleteSession(app, sid) {
        if (this.fail) throw this.fail;
        this.deleted.push([app, sid]);
      },
    };
    clients.set(rec.endpoint, client);
    return client;
  }

  // A sidebar with one daemon listed, and a confirm() the test drives.
  async function mount(answer) {
    const registry = globalThis.MastState.createDaemons({ makeClient: makeStubClient });
    const deleted = [];
    const asked = [];
    const sidebar = globalThis.MastDaemonSidebar.create({
      listEl: listEl,
      registry: registry,
      confirm: (message) => {
        asked.push(message);
        return typeof answer === 'function' ? answer() : answer;
      },
      onDeleted: (d, s) => deleted.push([d.endpoint, s.id]),
    });
    sidebar.add('https://a');
    await sidebar.refresh('https://a');
    return { sidebar, registry, deleted, asked, client: clients.get('https://a') };
  }

  const rows = () => Array.from(listEl.querySelectorAll('.side-session'));
  const delControl = (id) => listEl.querySelector('[aria-label="Delete session ' + id + '"]');
  const notice = () => {
    const el = listEl.querySelector('.side-error');
    return el ? el.textContent : '';
  };

  beforeEach(() => {
    delete globalThis.MastState;
    delete globalThis.MastDaemonSidebar;
    localStorage.clear();
    clients = new Map();
    document.body.replaceChildren();
    listEl = document.createElement('div');
    document.body.appendChild(listEl);
    load('state/subscriptions.js');
    load('state/daemons.js');
    load('daemon-sidebar.js');
  });

  it('offers the control on a deletable row and withholds it from default', async () => {
    await mount(true);
    expect(rows()).toHaveLength(2);
    expect(delControl('s1')).not.toBeNull();
    // The server refuses the bootstrap session, so offering the gesture
    // would only be a way to find that out.
    expect(delControl('default')).toBeNull();
  });

  it('asks with the title the operator can see, then deletes', async () => {
    const { asked, deleted, client } = await mount(true);
    delControl('s1').click();
    await vi.waitFor(() => expect(deleted).toEqual([['https://a', 's1']]));
    // "delete ops-triage?" and "delete s-8f2c?" are not equally
    // answerable questions.
    expect(asked[0]).toContain('ops triage (s1)');
    expect(client.deleted).toEqual([['demo', 's1']]);
    expect(delControl('s1')).toBeNull();
  });

  it('stops at a declined confirm', async () => {
    const { asked, deleted, client } = await mount(false);
    delControl('s1').click();
    await Promise.resolve();
    expect(asked).toHaveLength(1);
    expect(client.deleted).toEqual([]);
    expect(deleted).toEqual([]);
    expect(delControl('s1')).not.toBeNull();
  });

  it('activates from the keyboard, since role=button promises that', async () => {
    const { client } = await mount(true);
    delControl('s1').dispatchEvent(
      new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    await vi.waitFor(() => expect(client.deleted).toEqual([['demo', 's1']]));
  });

  // The row's own click handler opens the session. Deleting one must
  // not also open it on the way out.
  it('does not open the session it is deleting', async () => {
    const registry = globalThis.MastState.createDaemons({ makeClient: makeStubClient });
    const opened = [];
    const sidebar = globalThis.MastDaemonSidebar.create({
      listEl: listEl,
      registry: registry,
      confirm: () => true,
      onOpen: (d, s) => opened.push(s.id),
    });
    sidebar.add('https://a');
    await sidebar.refresh('https://a');
    delControl('s1').click();
    await vi.waitFor(() => expect(clients.get('https://a').deleted).toHaveLength(1));
    expect(opened).toEqual([]);
  });

  // Not the daemon's lastError: the sidebar only paints that when the
  // record's state is 'error', so writing there would be a silent
  // failure — and the daemon is fine.
  it('shows a refusal without marking the daemon unhealthy', async () => {
    const { registry, deleted, client } = await mount(true);
    client.fail = new Error('session is running');
    delControl('s1').click();
    await vi.waitFor(() => expect(notice()).toContain('session is running'));
    expect(deleted).toEqual([]);
    expect(registry.getDaemon('https://a').state).toBe('connected');
    expect(delControl('s1')).not.toBeNull();
  });

  it('clears the notice once a delete succeeds', async () => {
    const { client } = await mount(true);
    client.fail = new Error('session is running');
    delControl('s1').click();
    await vi.waitFor(() => expect(notice()).toContain('session is running'));
    client.fail = null;
    delControl('s1').click();
    await vi.waitFor(() => expect(notice()).toBe(''));
  });

  // index.html said this from the setup modal, and #61 deleted that
  // document. Without it a signed-out browser gets a sidebar of rows
  // reading "unauthorized" and no hint that reloading is the fix — the
  // page could not have been served at all without a fresh sign-in.
  describe('an expired session with the origin', () => {
    function discoversWith(descriptor) {
      globalThis.AttachClient = { discoverConfig: async () => descriptor };
    }

    const base = {
      ok: false,
      status: 401,
      unauthenticated: true,
      mode: '',
      endpoint: '',
      multiDaemon: false,
      backends: [],
      authMode: '',
      authenticated: false,
      identity: '',
    };

    async function boot() {
      const registry = globalThis.MastState.createDaemons({ makeClient: makeStubClient });
      const sidebar = globalThis.MastDaemonSidebar.create({
        listEl,
        registry,
        confirm: () => true,
      });
      const registered = await sidebar.boot();
      return { sidebar, registered };
    }

    it('says so on the row discovery produced', async () => {
      discoversWith(base);
      const { registered } = await boot();
      expect(registered).toEqual(['/']);
      expect(notice()).toContain('reload the page');
    });

    // Sticky: unlike a failed delete, this does not stop being true
    // while you look at it.
    it('does not time out', async () => {
      vi.useFakeTimers();
      try {
        discoversWith(base);
        await boot();
        vi.advanceTimersByTime(60000);
        expect(notice()).toContain('reload the page');
      } finally {
        vi.useRealTimers();
      }
    });

    it('stays quiet when the origin is happy', async () => {
      discoversWith({ ...base, ok: true, status: 200, unauthenticated: false, mode: 'mock' });
      await boot();
      expect(notice()).toBe('');
    });
  });
});

// Ownership rendering (PR 6, #63). The sidebar is the only place that
// lists sessions nobody has opened, which makes it the only place that
// can show one operator another operator's roster — so what it says
// about whose session a row is deserves a faster test than Playwright.
describe('MastDaemonSidebar — mine versus shared with me', () => {
  let clients;
  let listEl;

  function makeStubClient(rec) {
    const client = {
      endpoint: rec.endpoint,
      caller: 'ada@example.com',
      whoamiFail: null,
      // Two rows: one owned by the caller, one shared with them. Both
      // are in the list because the list is ACL-filtered upstream.
      sessions: [
        { id: 's1', app: 'demo', user: 'ada@example.com' },
        { id: 's2', app: 'demo', user: 'grace@example.com' },
      ],
      async listSessions() {
        return this.sessions;
      },
      async whoami() {
        if (this.whoamiFail) throw this.whoamiFail;
        return { identity: this.caller, admin: false, source: 'stub', proxy_by: '' };
      },
      async deleteSession() {},
    };
    clients.set(rec.endpoint, client);
    return client;
  }

  async function mount(tweak) {
    const registry = globalThis.MastState.createDaemons({ makeClient: makeStubClient });
    const sidebar = globalThis.MastDaemonSidebar.create({ listEl: listEl, registry: registry });
    sidebar.add('https://a');
    if (tweak) tweak(clients.get('https://a'));
    await sidebar.refresh('https://a');
    return { sidebar, registry };
  }

  const delControl = (id) => listEl.querySelector('[aria-label="Delete session ' + id + '"]');
  const rowFor = (n) => listEl.querySelectorAll('.side-session')[n];

  beforeEach(() => {
    delete globalThis.MastState;
    delete globalThis.MastDaemonSidebar;
    localStorage.clear();
    clients = new Map();
    document.body.replaceChildren();
    listEl = document.createElement('div');
    document.body.appendChild(listEl);
    load('state/subscriptions.js');
    load('state/daemons.js');
    load('daemon-sidebar.js');
  });

  it('marks the row somebody else owns, and leaves your own unmarked', async () => {
    await mount();
    expect(rowFor(0).dataset.own).toBe('mine');
    expect(rowFor(0).querySelector('.side-session-owner')).toBeNull();

    expect(rowFor(1).dataset.own).toBe('shared');
    const badge = rowFor(1).querySelector('.side-session-owner');
    // The local part is what tells two people apart when everyone
    // shares a domain; the whole address stays in the tooltip.
    expect(badge.textContent).toBe('grace');
    expect(badge.title).toBe('shared with you by grace@example.com');
    expect(rowFor(1).title).toContain('shared by grace@example.com');
  });

  // Read access is not admin access: pkg/auth's matrix gives Admin to
  // the owner alone, so offering the gesture on a shared row would only
  // be a way to collect a 403.
  it('withholds the delete control from a session somebody shared', async () => {
    await mount();
    expect(delControl('s1')).not.toBeNull();
    expect(delControl('s2')).toBeNull();
  });

  it('says nothing at all when the daemon cannot name the caller', async () => {
    await mount(function (c) {
      c.whoamiFail = new Error('HTTP 404');
    });
    expect(rowFor(0).dataset.own).toBeUndefined();
    expect(rowFor(1).dataset.own).toBeUndefined();
    expect(listEl.querySelector('.side-session-owner')).toBeNull();
    // Unknown ownership is not a reason to withhold a gesture that may
    // well be permitted — the server is still the one that decides.
    expect(delControl('s2')).not.toBeNull();
  });

  it('names the caller on the daemon, and on the button that owns by it', async () => {
    await mount();
    expect(listEl.querySelector('.side-daemon-name').title).toBe(
      'https://a — you are ada@example.com'
    );
    const add = Array.from(listEl.querySelectorAll('.side-icon')).find(function (b) {
      return b.title.startsWith('New session');
    });
    expect(add.title).toBe('New session on a, owned by ada@example.com');
  });
});

// The rename gesture (PR 3, #92). POST /sessions/{sid}/title landed in
// protocol 1.10.0, and its contract has four edges a naive
// implementation walks straight off: `""` clears while an omitted key
// is a 400, the 200 echoes what was actually stored, `persisted:false`
// is the norm rather than a failure, and the two refusals (404, 501)
// mean different things. Each one gets a case here, because not one of
// them is visible in a screenshot.
describe('MastDaemonSidebar — the rename gesture', () => {
  let clients;
  let listEl;

  function makeStubClient(rec) {
    const client = {
      endpoint: rec.endpoint,
      caller: 'ada@example.com',
      sessions: [
        { id: 's1', app: 'demo', user: 'ada@example.com', title: 'ops triage' },
        { id: 's2', app: 'demo', user: 'grace@example.com' },
        { id: 'default', app: 'demo', user: 'ada@example.com' },
      ],
      titled: [],
      fail: null,
      persisted: false,
      detail: '',
      async listSessions() {
        return this.sessions;
      },
      async whoami() {
        return { identity: this.caller, admin: false, source: 'stub', proxy_by: '' };
      },
      async deleteSession() {},
      // Normalizes on the way in, the way a host does — so a test that
      // asserts the rendered name is asserting the echo and not the
      // string it typed.
      async setTitleFor(sid, title) {
        if (this.fail) throw this.fail;
        this.titled.push([sid, title]);
        return {
          session: sid,
          title: String(title)
            .trim()
            .replace(/^[“"]|[”"]$/g, ''),
          persisted: this.persisted,
          detail: this.detail,
        };
      },
    };
    clients.set(rec.endpoint, client);
    return client;
  }

  // `answers` is what the prompt returns, in order. null is a cancel.
  async function mount(answers) {
    const queue = Array.isArray(answers) ? answers.slice() : [answers];
    const registry = globalThis.MastState.createDaemons({ makeClient: makeStubClient });
    const asked = [];
    const sidebar = globalThis.MastDaemonSidebar.create({
      listEl: listEl,
      registry: registry,
      prompt: (message, value) => {
        asked.push({ message, value });
        return queue.length ? queue.shift() : null;
      },
    });
    sidebar.add('https://a');
    await sidebar.refresh('https://a');
    return { sidebar, registry, asked, client: clients.get('https://a') };
  }

  const renControl = (id) => listEl.querySelector('[aria-label="Rename session ' + id + '"]');
  const rowText = (id) =>
    renControl(id).parentElement.querySelector('.side-session-id').textContent;
  const notice = () => {
    const el = listEl.querySelector('.side-error');
    return el ? el.textContent : '';
  };

  beforeEach(() => {
    delete globalThis.MastState;
    delete globalThis.MastDaemonSidebar;
    localStorage.clear();
    clients = new Map();
    document.body.replaceChildren();
    listEl = document.createElement('div');
    document.body.appendChild(listEl);
    load('state/subscriptions.js');
    load('state/daemons.js');
    load('daemon-sidebar.js');
  });

  it('offers the control on owned rows, including default', async () => {
    await mount(null);
    expect(renControl('s1')).not.toBeNull();
    // Unlike delete: the bootstrap session refuses destruction, not
    // naming.
    expect(renControl('default')).not.toBeNull();
    // Title is Write-gated and a shared row may be a viewer's, which
    // the roster cannot tell us — so the gesture stays off it.
    expect(renControl('s2')).toBeNull();
  });

  it('prefills with the current name and stores the normalized echo', async () => {
    const { asked, client } = await mount('  “Paging alert”  ');
    renControl('s1').click();
    await vi.waitFor(() => expect(client.titled).toEqual([['s1', '  “Paging alert”  ']]));
    expect(asked[0].value).toBe('ops triage');
    // What the host kept, not what the operator typed.
    expect(rowText('s1')).toBe('Paging alert');
  });

  it('sends the empty string to clear, and the row falls back to the id', async () => {
    const { client } = await mount('');
    renControl('s1').click();
    await vi.waitFor(() => expect(client.titled).toEqual([['s1', '']]));
    expect(rowText('s1')).toBe('s1');
  });

  // The whole reason the endpoint takes a pointer: "" and omitted are
  // different instructions, and a cancelled prompt is the omitted one.
  it('sends nothing at all when the prompt is cancelled', async () => {
    const { client } = await mount(null);
    renControl('s1').click();
    await Promise.resolve();
    expect(client.titled).toEqual([]);
    expect(rowText('s1')).toBe('ops triage');
  });

  it('sends nothing when the name came back unchanged', async () => {
    const { client } = await mount('ops triage');
    renControl('s1').click();
    await Promise.resolve();
    expect(client.titled).toEqual([]);
  });

  // The bug this case exists to pre-empt: false is the norm for a
  // daemon with no ACL store, and reading it as a failure would put an
  // error on every successful rename.
  it('treats persisted:false as the success it is', async () => {
    const { client } = await mount('renamed');
    client.persisted = false;
    renControl('s1').click();
    await vi.waitFor(() => expect(rowText('s1')).toBe('renamed'));
    expect(notice()).toBe('');
  });

  // `detail` is the other case — a store that was wired and refused —
  // and that one an operator does want to hear about.
  it('reports a store that was there and failed', async () => {
    const { client } = await mount('renamed');
    client.detail = 'acl store write failed';
    renControl('s1').click();
    await vi.waitFor(() => expect(notice()).toContain('acl store write failed'));
    // Still renamed: the name is live for as long as the process is.
    expect(rowText('s1')).toBe('renamed');
  });

  // An owner always has Write, so the only 404 reachable from this
  // control is a daemon that predates the route. Naming the version is
  // the difference between a dead end and an upgrade.
  it('reads a 404 as a daemon older than the route', async () => {
    const { client } = await mount('renamed');
    const e = new Error('POST /sessions/s1/title → HTTP 404: not found');
    e.status = 404;
    client.fail = e;
    renControl('s1').click();
    await vi.waitFor(() => expect(notice()).toContain('1.10.0'));
    expect(rowText('s1')).toBe('ops triage');
  });

  it('reads a 501 as a host with no title capability', async () => {
    const { client } = await mount('renamed');
    const e = new Error('POST /sessions/s1/title → HTTP 501: not implemented');
    e.status = 501;
    client.fail = e;
    renControl('s1').click();
    await vi.waitFor(() => expect(notice()).toContain('does not implement renaming'));
  });

  it('does not open the session it is renaming', async () => {
    const registry = globalThis.MastState.createDaemons({ makeClient: makeStubClient });
    const opened = [];
    const sidebar = globalThis.MastDaemonSidebar.create({
      listEl: listEl,
      registry: registry,
      prompt: () => 'renamed',
      onOpen: (d, s) => opened.push(s.id),
    });
    sidebar.add('https://a');
    await sidebar.refresh('https://a');
    renControl('s1').click();
    await vi.waitFor(() => expect(clients.get('https://a').titled).toHaveLength(1));
    expect(opened).toEqual([]);
  });

  it('activates from the keyboard, since role=button promises that', async () => {
    const { client } = await mount('renamed');
    renControl('s1').dispatchEvent(
      new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    await vi.waitFor(() => expect(client.titled).toEqual([['s1', 'renamed']]));
  });
});
