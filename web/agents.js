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

// MastAgents — the attached-daemon registry and the sidebar that lists
// it, shared by every multi-session shell.
//
// The registry is the same localStorage contract index.html writes
// ('mast-web:daemons', with the legacy single-entry 'mast-web:config'
// as a fallback), so a daemon added in any shell shows up in all of
// them. Each daemon keeps one session-less AttachClient purely for
// listSessions / createSession; the live SSE clients belong to the
// terminals.
//
// This is deliberately ignorant of what a shell *does* with a session.
// spatial.html opens a floating panel in a 3D room, solo.html opens a
// tab in one fixed frame; both hand this module a callback and a way to
// ask "is this session already open, and is it the one in front?" so
// the rows can be painted accordingly.
//
// Requires: attach-core/{errors,client}.js, and .side-* styles from
// spatial.css.
//
// With an empty registry, boot() asks the server where its attach API
// is (GET /config) before falling back to the same-origin guess — which
// is what spares a hosted deployment's users from having to type
// --api-prefix into the sidebar's attach form. It resolves rather than
// returns for that reason.
//
//   const agents = MastAgents.create({ listEl, onOpen });
//   agents.boot().then(function (endpoints) { … });
window.MastAgents = (function () {
  'use strict';

  function aliasFor(endpoint) {
    if (endpoint === '/') return 'same-origin';
    try {
      const u = new URL(endpoint, window.location.href);
      return u.host || endpoint;
    } catch {
      return endpoint;
    }
  }

  // Rows somebody chose, newest contract first. Empty means nobody has
  // said where the backend is — which is the case boot() asks the
  // server about.
  function storedDaemons() {
    let rows = [];
    try {
      const raw = localStorage.getItem('mast-web:daemons');
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) rows = arr;
    } catch {
      /* blocked storage — fall through */
    }
    if (rows.length === 0) {
      try {
        const raw = localStorage.getItem('mast-web:config');
        const cfg = raw ? JSON.parse(raw) : null;
        if (cfg && cfg.endpoint) rows = [cfg];
      } catch {
        /* blocked storage — fall through */
      }
    }
    return rows.filter(function (r) {
      return r && r.endpoint;
    });
  }

  // What GET /config said this boot, or null before boot() has asked /
  // when it had no reason to. Shells read it to prefill the attach
  // form with the path the deployment actually serves.
  let site = null;

  // opts:
  //   listEl        — container the sidebar rows are rendered into
  //   onOpen        — (daemon, session) a row was clicked
  //   onOpenAll     — (daemon) the ⊞ button; omitted hides the button
  //   onDetach      — (daemon) about to be dropped; close its terminals
  //   onRefreshed   — (daemon) its session list just came back
  //   sessionState  — (daemon, session) → { open, active } for row paint
  function create(opts) {
    const cfg = opts || {};
    const listEl = cfg.listEl;
    const onOpen = typeof cfg.onOpen === 'function' ? cfg.onOpen : function () {};
    const onOpenAll = typeof cfg.onOpenAll === 'function' ? cfg.onOpenAll : null;
    const onDetach = typeof cfg.onDetach === 'function' ? cfg.onDetach : function () {};
    const onRefreshed = typeof cfg.onRefreshed === 'function' ? cfg.onRefreshed : function () {};
    const sessionState =
      typeof cfg.sessionState === 'function'
        ? cfg.sessionState
        : function () {
            return { open: false, active: false };
          };

    const daemons = new Map();

    // Only rows somebody chose are written back. A derived row — the
    // same-origin guess, or whatever GET /config named — is re-derived
    // on every boot, so persisting it would freeze a deployment detail
    // that the deployment is the authority on, in a key three shells
    // read. It would also outlive the deployment change that made it
    // wrong, in the two shells whose only repair is the attach form.
    function persist() {
      const rows = [];
      daemons.forEach(function (d) {
        if (d.derived) return;
        rows.push({
          endpoint: d.endpoint,
          token: d.token || '',
          alias: d.alias,
          addedAt: d.addedAt,
        });
      });
      try {
        localStorage.setItem('mast-web:daemons', JSON.stringify(rows));
      } catch {
        /* blocked storage — the registry is still live in memory */
      }
    }

    function add(endpoint, token, opts) {
      const ep = (endpoint || '').trim().replace(/\/+$/, '') || '/';
      const existing = daemons.get(ep);
      if (existing) return existing;
      const d = {
        endpoint: ep,
        token: token || '',
        alias: aliasFor(ep),
        addedAt: new Date().toISOString(),
        state: 'connecting',
        sessions: [],
        error: '',
        derived: !!(opts && opts.derived),
        client: new window.AttachClient({ endpoint: ep, token: token || '' }),
      };
      daemons.set(ep, d);
      persist();
      render();
      return d;
    }

    function remove(d) {
      onDetach(d);
      daemons.delete(d.endpoint);
      persist();
      render();
    }

    async function refresh(d) {
      d.state = 'connecting';
      render();
      try {
        d.sessions = await d.client.listSessions();
        d.state = 'connected';
        d.error = '';
      } catch (e) {
        d.sessions = [];
        d.state = 'error';
        d.error = e && e.message ? e.message : String(e);
      }
      render();
      // Every list is a chance to bring a saved layout back — the boot
      // one usually does it, but if the daemon was down then, a manual
      // ↻ picks it up instead.
      onRefreshed(d);
    }

    function refreshAll() {
      daemons.forEach(function (d) {
        refresh(d);
      });
    }

    async function newSession(d) {
      try {
        const s = await d.client.createSession();
        await refresh(d);
        onOpen(d, { id: s.id, app: s.app, user: s.user, status: 'active' });
      } catch (e) {
        d.error = e && e.message ? e.message : String(e);
        render();
      }
    }

    // ── Sidebar ──────────────────────────────────────────────────────

    function render() {
      if (!listEl) return;
      listEl.replaceChildren();
      daemons.forEach(function (d) {
        const group = document.createElement('div');
        group.className = 'side-group';

        const head = document.createElement('div');
        head.className = 'side-daemon';
        head.dataset.state = d.state;
        const dot = document.createElement('span');
        dot.className = 'side-dot';
        const name = document.createElement('span');
        name.className = 'side-daemon-name';
        name.textContent = d.alias;
        name.title = d.endpoint;
        head.appendChild(dot);
        head.appendChild(name);

        if (onOpenAll) {
          const all = document.createElement('button');
          all.type = 'button';
          all.className = 'side-icon';
          all.textContent = '⊞';
          all.title = 'Open all ' + d.sessions.length + ' sessions on ' + d.alias + '  (o)';
          all.disabled = d.sessions.length === 0;
          all.addEventListener('click', function () {
            onOpenAll(d);
          });
          head.appendChild(all);
        }

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'side-icon';
        addBtn.textContent = '+';
        addBtn.title = 'New session on ' + d.alias;
        addBtn.addEventListener('click', function () {
          newSession(d);
        });
        head.appendChild(addBtn);

        const drop = document.createElement('button');
        drop.type = 'button';
        drop.className = 'side-icon';
        drop.textContent = '×';
        drop.title = 'Detach ' + d.alias;
        drop.addEventListener('click', function () {
          remove(d);
        });
        head.appendChild(drop);
        group.appendChild(head);

        if (d.state === 'error') {
          const err = document.createElement('div');
          err.className = 'side-error';
          err.textContent = d.error || 'unreachable';
          group.appendChild(err);
        } else if (d.sessions.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'side-empty';
          empty.textContent = d.state === 'connecting' ? 'listing…' : 'no sessions';
          group.appendChild(empty);
        }

        d.sessions.forEach(function (s) {
          const state = sessionState(d, s) || {};
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'side-session';
          if (state.open) row.classList.add('open');
          if (state.active) row.classList.add('active');
          row.dataset.status = s.status || 'active';

          const idEl = document.createElement('span');
          idEl.className = 'side-session-id';
          idEl.textContent = s.id;
          const metaEl = document.createElement('span');
          metaEl.className = 'side-session-meta';
          metaEl.textContent = s.app || s.user || '';
          row.appendChild(idEl);
          row.appendChild(metaEl);
          row.title = s.id + (s.app ? ' · ' + s.app : '') + ' · ' + d.endpoint;

          row.addEventListener('click', function () {
            onOpen(d, s);
          });
          group.appendChild(row);
        });

        listEl.appendChild(group);
      });
    }

    // Registers every daemon and lists each one. Resolves with the
    // endpoints it registered, which is what a shell restoring saved
    // terminals needs to tell "this row's daemon is gone" from "this
    // row's daemon hasn't answered yet".
    //
    // Async for the one case where storage can't answer. With nothing
    // stored the guess has always been same-origin `/`, and that is
    // wrong in exactly the deployment that most needs it right: a
    // hosted BFF serves the attach API under --api-prefix, so the
    // operator had to know to type `/attach` into a form these two
    // shells put in a sidebar. The server already knows; ask it once,
    // before guessing.
    //
    // Only when nothing is stored. A row somebody chose outranks
    // anything discovered — the operator pointing this shell at a
    // second daemon is not a thing the origin gets a vote on.
    async function boot() {
      let rows = storedDaemons();
      let derived = false;
      if (rows.length === 0) {
        derived = true;
        site = await window.AttachClient.discoverConfig();
        rows = [{ endpoint: site.endpoint || '/', token: '' }];
      }
      const registered = [];
      rows.forEach(function (row) {
        registered.push(row.endpoint);
        refresh(add(row.endpoint, row.token, { derived: derived }));
      });
      return registered;
    }

    return {
      daemons: daemons,
      add: add,
      remove: remove,
      refresh: refresh,
      refreshAll: refreshAll,
      newSession: newSession,
      render: render,
      boot: boot,
      site: function () {
        return site;
      },
    };
  }

  return { create: create, aliasFor: aliasFor };
})();
