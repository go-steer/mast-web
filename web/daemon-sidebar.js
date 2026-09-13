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
// Session delete lives here rather than in a terminal (PR 3b, #60): a
// panel cannot sensibly be the thing that removes the session it is
// attached to, and the sidebar is the one place that lists sessions
// nobody has opened. The shell is told after the fact — onDeleted —
// because closing the terminals is its job, not this module's.
//
// Requires: state/{subscriptions,daemons}.js, attach-core/{errors,
// client}.js, and .side-* styles from chrome.css.
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
  //   onDeleted     — (daemon, session) it is gone upstream; close it
  //   confirm       — (message) → bool; window.confirm unless overridden
  //   sessionState  — (daemon, session) → { open, active } for row paint
  function create(opts) {
    const cfg = opts || {};
    const listEl = cfg.listEl;
    const registry = cfg.registry || window.MastState.createDaemons();
    const onOpen = typeof cfg.onOpen === 'function' ? cfg.onOpen : function () {};
    const onOpenAll = typeof cfg.onOpenAll === 'function' ? cfg.onOpenAll : null;
    const onDetach = typeof cfg.onDetach === 'function' ? cfg.onDetach : function () {};
    const onRefreshed = typeof cfg.onRefreshed === 'function' ? cfg.onRefreshed : function () {};
    const onDeleted = typeof cfg.onDeleted === 'function' ? cfg.onDeleted : function () {};
    const ask =
      typeof cfg.confirm === 'function'
        ? cfg.confirm
        : function (message) {
            return window.confirm(message);
          };
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

    // Per-daemon, transient, and not in the registry: a failed delete
    // is a fact about this gesture, not about the daemon's health, and
    // writing it to the record would leave a permanent red line under a
    // backend that is fine. Cleared on the next successful mutation or
    // when it times out.
    const notices = new Map();
    const noticeTimers = new Map();
    const NOTICE_MS = 8000;

    // `sticky` is for the one notice that does not stop being true while
    // you look at it — see boot().
    function setNotice(endpoint, text, sticky) {
      window.clearTimeout(noticeTimers.get(endpoint));
      noticeTimers.delete(endpoint);
      if (!text) {
        notices.delete(endpoint);
      } else {
        notices.set(endpoint, text);
        if (!sticky) {
          noticeTimers.set(
            endpoint,
            window.setTimeout(function () {
              notices.delete(endpoint);
              noticeTimers.delete(endpoint);
              render();
            }, NOTICE_MS)
          );
        }
      }
      render();
    }

    // Deleting a session is the one destructive thing in this sidebar,
    // so it asks first — and it asks with the title the operator can
    // see, because "delete ops-triage?" and "delete s-8f2c?" are not
    // equally answerable questions.
    //
    // The terminals go after the server agrees, not before: a refused
    // delete that had already closed the panel would cost the operator
    // a transcript for nothing.
    async function deleteSession(d, s) {
      const label = s.title ? s.title + ' (' + s.id + ')' : s.id;
      if (!ask('Delete session ' + label + ' on ' + d.alias + '?\n\nThis cannot be undone.')) {
        return { ok: false, error: 'cancelled' };
      }
      const r = await registry.deleteSession(d, s);
      if (!r.ok) {
        setNotice(d.endpoint, 'delete failed: ' + r.error);
        return r;
      }
      setNotice(d.endpoint, '');
      onDeleted(d, s);
      return r;
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
      // A 401 from GET /config is the one discovery failure that names
      // its own fix: the deployment does authenticate, and this
      // document's session with it has expired. Every list below is
      // about to fail the same way, and four rows reading "unauthorized"
      // do not add up to "reload the page" — the document could not have
      // been served at all without a fresh sign-in, so reloading is the
      // recovery. index.html used to say this from the setup modal;
      // #61 retired that shell, and the sentence moved here.
      const site = registry.site && registry.site();
      if (site && site.unauthenticated) {
        registered.forEach(function (endpoint) {
          setNotice(endpoint, 'Your session with this server expired — reload the page.', true);
        });
      }
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

        const notice = notices.get(d.endpoint);
        if (notice) {
          const line = document.createElement('div');
          line.className = 'side-error';
          line.textContent = notice;
          group.appendChild(line);
        }

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

          // v1.6.0 gave session rows an optional `title`. When there is
          // one it wins the wide slot — it's the whole point of the
          // field — and the id moves to the meta slot rather than
          // disappearing, because the id is what correlates a row with
          // an event log or a URL. Untitled rows are unchanged.
          const idEl = document.createElement('span');
          idEl.className = 'side-session-id';
          idEl.textContent = s.title || s.id;
          const metaEl = document.createElement('span');
          metaEl.className = 'side-session-meta';
          metaEl.textContent = s.title ? s.id : s.app || s.user || '';
          row.appendChild(idEl);
          row.appendChild(metaEl);
          row.title =
            (s.title ? s.title + ' · ' : '') +
            s.id +
            (s.app ? ' · ' + s.app : '') +
            ' · ' +
            d.endpoint;

          // A <span role="button"> rather than a nested <button>, which
          // is invalid inside the row's own button — the same trick the
          // solo tab strip uses for its close affordance.
          //
          // `default` gets no delete control at all: the server refuses
          // it, so offering the gesture would only be a way to find that
          // out. Ditto a daemon that hasn't connected — there is nothing
          // to send the DELETE on.
          if (s.id !== 'default' && d.client) {
            const del = document.createElement('span');
            del.className = 'side-session-del';
            del.setAttribute('role', 'button');
            del.setAttribute('aria-label', 'Delete session ' + s.id);
            del.tabIndex = 0;
            del.textContent = '×';
            del.title = 'Delete session ' + s.id + ' on ' + d.alias;
            del.addEventListener('click', function (e) {
              // Without this the row's own handler opens the session
              // the operator is in the middle of deleting.
              e.stopPropagation();
              deleteSession(d, s);
            });
            // role=button without this is a lie: a <span> gets none of
            // the keyboard behaviour the role promises.
            del.addEventListener('keydown', function (e) {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              e.stopPropagation();
              deleteSession(d, s);
            });
            row.appendChild(del);
          }

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
      deleteSession: deleteSession,
      render: render,
      boot: boot,
      site: registry.site,
    };
  }

  return { create: create, aliasFor: window.MastState.createDaemons.aliasFor };
})();
