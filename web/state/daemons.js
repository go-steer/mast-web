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
  //     caller,          // who this daemon says we are, or '' — see refresh()
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
        caller: rec.caller !== undefined ? rec.caller : existing.caller || '',
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

    // Who does this daemon think we are? Per daemon, not per session:
    // each backend resolves the caller with its own auth mode, so two
    // attached daemons can legitimately answer differently, and the
    // sidebar has to be able to say whose session a row is before any
    // terminal exists. (A terminal learns the same fact for itself on
    // connect — state/session.js — but that is the wrong moment and
    // the wrong scope for a list.)
    //
    // Never fatal. GET /whoami is v1.4.0+, so an older daemon 404s,
    // and an anonymous listener answers with an empty identity. Both
    // mean the same thing to a caller here — we cannot say who we are
    // — and neither is a reason to report the daemon as unreachable
    // when its session list came back fine.
    async function callerOn(rec) {
      try {
        const who = await rec.client.whoami();
        return (who && who.identity) || '';
      } catch {
        return '';
      }
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
        // Both in flight together. The identity is not a follow-up to
        // the list, it is what the list MEANS — without it every row
        // is a session belonging to nobody in particular — so paying
        // two round trips in sequence for it would be a repaint with
        // the rows briefly unattributed.
        const [sessions, caller] = await Promise.all([rec.client.listSessions(), callerOn(rec)]);
        patchDaemon(ep, {
          sessions: sessions,
          caller: caller,
          state: 'connected',
          lastError: '',
        });
      } catch (e) {
        patchDaemon(ep, {
          sessions: [],
          state: 'error',
          lastError: e && e.message ? e.message : String(e),
        });
      }
      return getDaemon(ep);
    }

    // Mine, or shared with me?
    //
    // The wire does not say. A session descriptor is {app, user,
    // sessionID, has_event_log, status, last_touched_at, title}
    // (core-agent pkg/attach/handlers.go:353) and the ACL kept
    // alongside it is never serialised — session_acl_store.go holds
    // `UserID` and `Owner` as SEPARATE persisted fields and emits
    // neither. So ownership is derived, from two things that ARE on
    // the wire:
    //
    //   1. the list is already ACL-filtered per caller, so every row
    //      in it is one this caller is allowed to read; and
    //   2. a session created through POST /sessions has UserID equal
    //      to its Owner, because pkg/compose/multi_session.go:481
    //      builds it as agent.WithSession(caller.Identity, sid).
    //
    // Given both: `user === me` is mine, and anything else is a
    // session somebody shared with me, because otherwise it would not
    // be in the list at all.
    //
    // (2) is a factory convention, not a protocol guarantee. A session
    // registered through the legacy Register() path has no ACL owner
    // and whatever UserID the daemon chose, so it reads as 'shared'.
    // That is the safe direction to be wrong in: the label claims less
    // than the truth rather than more.
    //
    // With no known caller — pre-1.4.0 daemon, anonymous listener —
    // there is nothing to compare against and the answer is 'unknown'.
    // Callers should render nothing rather than guess.
    function ownership(d, session) {
      const rec = typeof d === 'string' ? getDaemon(normalize(d)) : d;
      const me = rec && rec.caller;
      const user = session && session.user;
      if (!me) return 'unknown';
      return user === me ? 'mine' : 'shared';
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
    //
    // The create is also what makes you the owner: POST /sessions
    // stamps the ACL Owner from the authenticated caller and refuses a
    // body that names anyone else (handlers_create_session.go:96-108).
    // That consequence used to be invisible — the button said "new
    // session" and the ownership happened offstage — so the mismatch
    // check below exists to say it out loud in the one case where it
    // goes wrong. A session owned by somebody else is not one this
    // operator can delete or share, and finding that out later, from a
    // row that quietly renders as 'shared', is finding out too late.
    async function newSession(d) {
      const ep = endpointOf(d);
      const rec = getDaemon(ep);
      if (!rec) return null;
      try {
        const s = await rec.client.createSession();
        await refresh(ep);
        const me = (getDaemon(ep) || {}).caller;
        if (me && s.user && s.user !== me) {
          patchDaemon(ep, {
            lastError: 'created session ' + s.id + ' is owned by ' + s.user + ', not ' + me,
          });
        }
        return { id: s.id, app: s.app, user: s.user, status: 'active' };
      } catch (e) {
        patchDaemon(ep, { lastError: e && e.message ? e.message : String(e) });
        return null;
      }
    }

    // Deletes a session on the daemon and drops it from the record.
    // Resolves { ok, error } rather than throwing: the caller is a
    // sidebar button, and every failure here is something an operator
    // should read rather than something a shell should crash on.
    //
    // The qualified DELETE /sessions/{app}/{sid} path, which is why the
    // row has to be in the last listing — the unqualified shortcut 409s
    // when two tenants have a session of the same name.
    async function deleteSession(d, session) {
      const ep = endpointOf(d);
      const rec = getDaemon(ep);
      if (!rec) return { ok: false, error: 'daemon ' + ep + ' is not attached' };
      const sid = typeof session === 'string' ? session : session && session.id;
      const row = (rec.sessions || []).find(function (s) {
        return s.id === sid;
      });
      if (!row) {
        return { ok: false, error: 'session ' + sid + ' is not in this listing — refresh first' };
      }
      // core-agent 403s on the bootstrap session (it is what the daemon
      // falls back to), so say so here rather than spend a round trip
      // learning it.
      if (sid === 'default') {
        return { ok: false, error: 'the bootstrap `default` session cannot be deleted' };
      }
      try {
        await rec.client.deleteSession(row.app, sid);
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
      // Drop it locally rather than re-listing: the row is gone either
      // way, and a refresh would repaint the whole group for one row.
      patchDaemon(ep, {
        sessions: (getDaemon(ep).sessions || []).filter(function (s) {
          return s.id !== sid;
        }),
      });
      return { ok: true, error: '' };
    }

    // Renames a session (POST /sessions/{sid}/title, v1.10.0 #808) and
    // writes the STORED name onto the local row. Resolves
    // { ok, title, persisted, detail, error, status } — same
    // don't-throw contract as deleteSession, and for the same reason.
    //
    // Four things the contract makes easy to get wrong, all of which
    // this function or its caller has to honour:
    //
    //   1. `title` is required and `""` is a real value — it clears the
    //      name and re-arms inference. Omitting the key is a 400. So
    //      "clear it" and "don't touch it" are different calls, and the
    //      second one never reaches here: a cancelled prompt returns
    //      before we are called at all.
    //   2. The 200 carries what was stored after normalization (a
    //      60-rune cap, a decorative-quote strip). That is what goes on
    //      the row — not the string we sent, which is frequently not
    //      what the host kept.
    //   3. `persisted:false` IS NOT AN ERROR. It is the norm for a
    //      daemon with no ACL store: the rename is live for the life of
    //      the process and only won't survive a restart. `detail` is
    //      the other case — a store that was wired and failed — and is
    //      the only one worth a notice.
    //   4. A 404 here is not ambiguous the way the ACL's is, because
    //      the caller owns the row (the sidebar only offers this on
    //      rows it derived as 'mine') and title is gated on
    //      ActionSessionWrite, which an owner always has. So the one
    //      remaining meaning is "this daemon predates the route", and
    //      the caller can say that rather than hedge.
    async function renameSession(d, session, title) {
      const ep = endpointOf(d);
      const rec = getDaemon(ep);
      if (!rec) return { ok: false, error: 'daemon ' + ep + ' is not attached' };
      const sid = typeof session === 'string' ? session : session && session.id;
      if (!sid) return { ok: false, error: 'no session to rename' };
      if (typeof title !== 'string') return { ok: false, error: 'a title is required' };
      let res;
      try {
        res = await rec.client.setTitleFor(sid, title);
      } catch (e) {
        return {
          ok: false,
          error: e && e.message ? e.message : String(e),
          status: e && e.status,
        };
      }
      const stored = res && typeof res.title === 'string' ? res.title : '';
      patchDaemon(ep, {
        sessions: (getDaemon(ep).sessions || []).map(function (s) {
          return s.id === sid ? { ...s, title: stored } : s;
        }),
      });
      return {
        ok: true,
        error: '',
        title: stored,
        persisted: !!(res && res.persisted),
        detail: (res && res.detail) || '',
      };
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
      ownership,
      // Registry operations
      add,
      remove,
      refresh,
      refreshAll,
      newSession,
      deleteSession,
      renameSession,
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
