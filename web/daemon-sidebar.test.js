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
});
