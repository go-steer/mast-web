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

// state/daemons — the attached-daemon registry. Each entry represents
// one operator-added backend daemon; the SPA holds a live SSE
// connection to each in parallel and aggregates their sessions in the
// sidebar. Cross-daemon session switch is instant — no reconnect —
// because both stay attached.
//
// Ports the coretuiremote pattern (internal/coretuiremote/
// capabilities.go:498-608): local rows + peer rows in a single
// sidebar, peer-tagged for provenance.
//
// ─── This file absorbed web/agents.js ──────────────────────────────
//
// Until v0.4 there were two of these: this store, loaded only by
// index.html, and MastAgents in web/agents.js, loaded only by the two
// new shells. Both held an AttachClient per endpoint and both read
// 'mast-web:daemons'. agents.js is gone; what it knew about
// persistence, discovery and listing lives here, and the sidebar it
// also drew lives in web/daemon-sidebar.js.
//
// The split follows the layering rule: state/ may reach down into
// attach-core (it constructs AttachClients and calls listSessions),
// and presentation reaches down into state/. Nothing here touches the
// DOM — which is why the fold is a split rather than a move.

window.MastState = window.MastState || {};

window.MastState.createDaemons = (function () {
  'use strict';

  if (!window.MastState.subscriptions) {
    throw new Error('state/daemons.js: subscriptions must load first');
  }
  const { createStore } = window.MastState.subscriptions;

  const STORAGE_KEY = 'mast-web:daemons';
  const LEGACY_KEY = 'mast-web:config';

  // Store shape:
  //   daemons: { [endpoint]: {
  //     endpoint,        // canonical URL (post-normalization)
  //     token,           // bearer or ''
  //     alias,           // short label for badges ("prod", "peer-1", etc.)
  //     addedAt,         // ISO timestamp of first add (for stable ordering)
  //     state,           // 'disconnected' | 'connecting' | 'connected' | 'error'
  //     lastError,       // human-readable most-recent error (or '')
  //     sessions,        // last-known session list from listSessions()
  //     derived,         // discovered rather than chosen — see persist()
  //     // Live refs — not persisted; set on connect(), cleared on remove().
  //     client, prompter,
  //   } }
  //   activeDaemon: <endpoint>   // whose SSE currently paints the transcript
  //
  // The client/prompter refs are stored here so the sidebar+router
  // can reach a specific daemon's handles without a parallel map.
  // Not persisted (localStorage carries endpoint/token/alias only —
  // refs rehydrate on boot via addDaemon-then-connect).
  const baseDaemonsState = {
    daemons: {},
    activeDaemon: '',
  };

  function aliasFor(endpoint) {
    if (endpoint === '/') return 'same-origin';
    try {
      const u = new URL(endpoint, window.location.href);
      return u.host || endpoint;
    } catch {
      return endpoint;
    }
  }

  // Trailing slashes are not a distinction worth keeping two registry
  // entries over.
  function normalize(endpoint) {
    return (endpoint || '').trim().replace(/\/+$/, '') || '/';
  }

  // Rows somebody chose, newest contract first. Empty means nobody has
  // said where the backend is — which is the case discover() asks the
  // server about.
  function storedRows() {
    let rows = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) rows = arr;
    } catch {
      /* blocked storage — fall through */
    }
    if (rows.length === 0) {
      try {
        const raw = localStorage.getItem(LEGACY_KEY);
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

  function createDaemons(opts) {
    const cfg = opts || {};
    // Injectable so a test can register daemons without a live
    // AttachClient; production passes nothing and gets the real one.
    const makeClient =
      typeof cfg.makeClient === 'function'
        ? cfg.makeClient
        : function (rec) {
            return new window.AttachClient({ endpoint: rec.endpoint, token: rec.token });
          };

    const store = createStore({ ...baseDaemonsState });

    // What GET /config said this boot, or null before discover() has
    // asked / when it had no reason to. Shells read it to prefill the
    // attach form with the path the deployment actually serves.
    let site = null;

    // ─── Actions ───────────────────────────────────────────────────────

    function addDaemon(rec) {
      if (!rec || !rec.endpoint) return;
      const state = store.get();
      const next = { ...state.daemons };
      // Upsert on endpoint — re-adding an existing daemon updates its
      // token / alias in place rather than shadowing.
      const existing = next[rec.endpoint] || {};
      next[rec.endpoint] = {
        endpoint: rec.endpoint,
        token: rec.token || '',
        alias: rec.alias || existing.alias || '',
        addedAt: existing.addedAt || rec.addedAt || '',
        state: rec.state || existing.state || 'disconnected',
        lastError: rec.lastError || '',
        sessions: rec.sessions || existing.sessions || [],
        derived: rec.derived !== undefined ? !!rec.derived : !!existing.derived,
        client: rec.client !== undefined ? rec.client : existing.client || null,
        prompter: rec.prompter !== undefined ? rec.prompter : existing.prompter || null,
      };
      store.set({ daemons: next });
    }

    function patchDaemon(endpoint, patch) {
      if (!endpoint) return;
      const state = store.get();
      const current = state.daemons[endpoint];
      if (!current) return;
      const next = { ...state.daemons, [endpoint]: { ...current, ...patch } };
      store.set({ daemons: next });
    }

    function removeDaemon(endpoint) {
      if (!endpoint) return;
      const state = store.get();
      if (!state.daemons[endpoint]) return;
      const next = { ...state.daemons };
      delete next[endpoint];
      const patch = { daemons: next };
      // If the removed one was active, hand off to the earliest-added
      // survivor. Empty registry → activeDaemon cleared.
      if (state.activeDaemon === endpoint) {
        const survivors = Object.values(next).sort(byAddedAt);
        patch.activeDaemon = survivors.length ? survivors[0].endpoint : '';
      }
      store.set(patch);
    }

    function setActiveDaemon(endpoint) {
      store.set({ activeDaemon: endpoint || '' });
    }

    // ─── Selectors ─────────────────────────────────────────────────────

    function getDaemon(endpoint) {
      return store.get().daemons[endpoint] || null;
    }

    function getActiveDaemon() {
      const s = store.get();
      return s.daemons[s.activeDaemon] || null;
    }

    // Ordered list — earliest-added first — for stable sidebar
    // rendering. Ties broken by endpoint string.
    function listDaemons() {
      return Object.values(store.get().daemons).slice().sort(byAddedAt);
    }

    // Map view for callers that want one, in insertion-safe registry
    // order. A snapshot: mutating it does not touch the store.
    function daemonMap() {
      const m = new Map();
      listDaemons().forEach(function (d) {
        m.set(d.endpoint, d);
      });
      return m;
    }

    function byAddedAt(a, b) {
      const ta = a.addedAt ? Date.parse(a.addedAt) : 0;
      const tb = b.addedAt ? Date.parse(b.addedAt) : 0;
      if (ta !== tb) return ta - tb;
      return (a.endpoint || '').localeCompare(b.endpoint || '');
    }

    // ─── Registry operations (was web/agents.js) ───────────────────────

    // Only rows somebody chose are written back. A derived row — the
    // same-origin guess, or whatever GET /config named — is re-derived
    // on every boot, so persisting it would freeze a deployment detail
    // that the deployment is the authority on, in a key every shell
    // reads. It would also outlive the deployment change that made it
    // wrong, in the shells whose only repair is the attach form.
    function persist() {
      const rows = [];
      listDaemons().forEach(function (d) {
        if (d.derived) return;
        rows.push({
          endpoint: d.endpoint,
          token: d.token || '',
          alias: d.alias,
          addedAt: d.addedAt,
        });
      });
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
      } catch {
        /* blocked storage — the registry is still live in memory */
      }
    }

    // Registers an endpoint and returns its record. Re-adding a known
    // endpoint returns the existing record untouched, client and all —
    // a second attach form submission for the same daemon must not
    // orphan the AttachClient its terminals are already holding.
    function add(endpoint, token, addOpts) {
      const ep = normalize(endpoint);
      const existing = getDaemon(ep);
      if (existing) return existing;
      const rec = {
        endpoint: ep,
        token: token || '',
        alias: aliasFor(ep),
        addedAt: new Date().toISOString(),
        state: 'connecting',
        sessions: [],
        lastError: '',
        derived: !!(addOpts && addOpts.derived),
      };
      rec.client = makeClient(rec);
      addDaemon(rec);
      persist();
      return getDaemon(ep);
    }

    function endpointOf(d) {
      return typeof d === 'string' ? normalize(d) : d && d.endpoint;
    }

    function remove(d) {
      removeDaemon(endpointOf(d));
      persist();
    }

    // Lists the daemon's sessions and folds the outcome into its
    // record. Resolves with the fresh record — callers that react to a
    // refresh need the post-list state, and the record they passed in
    // is a pre-list snapshot.
    async function refresh(d) {
      const ep = endpointOf(d);
      const rec = getDaemon(ep);
      if (!rec) return null;
      patchDaemon(ep, { state: 'connecting' });
      try {
        const sessions = await rec.client.listSessions();
        patchDaemon(ep, { sessions: sessions, state: 'connected', lastError: '' });
      } catch (e) {
        patchDaemon(ep, {
          sessions: [],
          state: 'error',
          lastError: e && e.message ? e.message : String(e),
        });
      }
      return getDaemon(ep);
    }

    function refreshAll() {
      return Promise.all(
        listDaemons().map(function (d) {
          return refresh(d.endpoint);
        })
      );
    }

    // Creates a session on the daemon and re-lists. Resolves with the
    // new session row, or null if the create failed — the error is on
    // the record either way.
    async function newSession(d) {
      const ep = endpointOf(d);
      const rec = getDaemon(ep);
      if (!rec) return null;
      try {
        const s = await rec.client.createSession();
        await refresh(ep);
        return { id: s.id, app: s.app, user: s.user, status: 'active' };
      } catch (e) {
        patchDaemon(ep, { lastError: e && e.message ? e.message : String(e) });
        return null;
      }
    }

    // The rows this boot should register, and whether they were
    // derived rather than chosen.
    //
    // Async for the one case where storage can't answer. With nothing
    // stored the guess has always been same-origin `/`, and that is
    // wrong in exactly the deployment that most needs it right: a
    // hosted BFF serves the attach API under --api-prefix, so the
    // operator had to know to type `/attach` into a form the new
    // shells put in a sidebar. The server already knows; ask it once,
    // before guessing.
    //
    // Only when nothing is stored. A row somebody chose outranks
    // anything discovered — the operator pointing a shell at a second
    // daemon is not a thing the origin gets a vote on.
    async function discover() {
      const rows = storedRows();
      if (rows.length > 0) return { rows: rows, derived: false };
      site = await window.AttachClient.discoverConfig();
      return { rows: [{ endpoint: site.endpoint || '/', token: '' }], derived: true };
    }

    return {
      store,
      get() {
        return store.get();
      },
      subscribe(fn) {
        return store.subscribe(fn);
      },
      // Store actions
      addDaemon,
      patchDaemon,
      removeDaemon,
      setActiveDaemon,
      getDaemon,
      getActiveDaemon,
      listDaemons,
      daemonMap,
      // Registry operations
      add,
      remove,
      refresh,
      refreshAll,
      newSession,
      discover,
      persist,
      site() {
        return site;
      },
      initialDaemonsState: baseDaemonsState,
    };
  }

  createDaemons.aliasFor = aliasFor;
  createDaemons.normalize = normalize;
  createDaemons.baseDaemonsState = baseDaemonsState;

  return createDaemons;
})();

// The classic shell's instance — see the note in state/session.js.
window.MastState.daemons = window.MastState.createDaemons();
