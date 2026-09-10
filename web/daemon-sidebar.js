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

// MastDaemonSidebar — the list of attached daemons and their sessions,
// shared by every multi-session shell.
//
// The registry itself is state/daemons.js; this is the view of it. It
// subscribes, so a daemon added or listed anywhere repaints here
// without the caller remembering to ask.
//
// This is deliberately ignorant of what a shell *does* with a session.
// spatial.html opens a floating panel in a 3D room, solo.html opens a
// tab in one fixed frame; both hand this module a callback and a way to
// ask "is this session already open, and is it the one in front?" so
// the rows can be painted accordingly.
//
// Requires: state/{subscriptions,daemons}.js, attach-core/{errors,
// client}.js, and .side-* styles from spatial.css.
//
//   const sidebar = MastDaemonSidebar.create({ listEl, onOpen });
//   sidebar.boot().then(function (endpoints) { … });
window.MastDaemonSidebar = (function () {
  'use strict';

  // opts:
  //   listEl        — container the sidebar rows are rendered into
  //   registry      — a state/daemons instance; one is created if absent
  //   onOpen        — (daemon, session) a row was clicked
  //   onOpenAll     — (daemon) the ⊞ button; omitted hides the button
  //   onDetach      — (daemon) about to be dropped; close its terminals
  //   onRefreshed   — (daemon) its session list just came back
  //   sessionState  — (daemon, session) → { open, active } for row paint
  function create(opts) {
    const cfg = opts || {};
    const listEl = cfg.listEl;
    const registry = cfg.registry || window.MastState.createDaemons();
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

    // Every registry change repaints. The imperative render() calls
    // that used to follow each mutation are gone; what remains public
    // is for the shell's own state — whether a row's panel is open or
    // in front is something only the shell knows.
    registry.subscribe(render);

    // ── Registry operations, wrapped with the shell's callbacks ──────

    function add(endpoint, token, addOpts) {
      return registry.add(endpoint, token, addOpts);
    }

    function remove(d) {
      // Detaching a daemon takes its terminals down with it, and they
      // have to go before the record they point at does.
      onDetach(d);
      registry.remove(d);
    }

    async function refresh(d) {
      const fresh = await registry.refresh(d);
      // Every list is a chance to bring a saved layout back — the boot
      // one usually does it, but if the daemon was down then, a manual
      // ↻ picks it up instead.
      if (fresh) onRefreshed(fresh);
      return fresh;
    }

    function refreshAll() {
      return Promise.all(
        registry.listDaemons().map(function (d) {
          return refresh(d.endpoint);
        })
      );
    }

    async function newSession(d) {
      const s = await registry.newSession(d);
      if (s) onOpen(registry.getDaemon(d.endpoint || d), s);
    }

    // Registers every daemon and lists each one. Resolves with the
    // endpoints it registered, which is what a shell restoring saved
    // terminals needs to tell "this row's daemon is gone" from "this
    // row's daemon hasn't answered yet".
    async function boot() {
      const found = await registry.discover();
      const registered = [];
      found.rows.forEach(function (row) {
        registered.push(row.endpoint);
        refresh(add(row.endpoint, row.token, { derived: found.derived }));
      });
      return registered;
    }

    // ── Sidebar ──────────────────────────────────────────────────────

    function render() {
      if (!listEl) return;
      listEl.replaceChildren();
      registry.listDaemons().forEach(function (d) {
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
          err.textContent = d.lastError || 'unreachable';
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

    return {
      registry: registry,
      // Snapshot, in registry order. A getter rather than a field: the
      // records are immutable now, so a Map captured once would go
      // stale the first time a daemon finished listing.
      get daemons() {
        return registry.daemonMap();
      },
      list: registry.listDaemons,
      add: add,
      remove: remove,
      refresh: refresh,
      refreshAll: refreshAll,
      newSession: newSession,
      render: render,
      boot: boot,
      site: registry.site,
    };
  }

  return { create: create, aliasFor: window.MastState.createDaemons.aliasFor };
})();
