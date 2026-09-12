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

// state/session — observable store for the current backend session.
//
// Holds everything about the currently-connected session that's
// downstream of what the attach protocol tells us:
//   - capabilities frame (v1.4.0 shape: features, slash_commands,
//     agent, caller_id)
//   - status (model, provider, turn state, context pct, perm mode)
//   - pause gate (v1.5.0): paused / since / reason / interrupted
//   - usage totals + per-model breakdown + last-turn cost with cache
//     attribution
//   - sessions list (from GET /sessions; includes idle/active status)
//   - cost-ceiling banner state
//   - inbox coalesce state (queued/dequeued per prompt_id)
//   - current session id + model
//   - server-advertised slash commands
//
// Initial value matches what app.js used to hold in `latest` + a few
// other module-scope vars.
//
// ─── One store per session, not one store ──────────────────────────
//
// This was a singleton through v0.3.0, which was the right shape for a
// shell with one session on screen and the wrong shape for a room with
// four. `createSession()` is the factory; `MastState.session` is one
// instance of it, the one the classic shell holds. Each terminal in
// spatial.html / solo.html holds its own.
//
// That is what makes per-terminal state observable from outside the
// terminal — the thing a real status bar, cross-session unread, and a
// fleet view all need and none of them could have while this state
// lived in a closure.

window.MastState = window.MastState || {};

window.MastState.createSession = (function () {
  'use strict';

  if (!window.MastState.subscriptions) {
    throw new Error('state/session.js: subscriptions must load first');
  }
  const { createStore } = window.MastState.subscriptions;

  const baseSessionState = {
    // Which backend this session lives on, and what to call it in a
    // tab strip or a panel title. Per-instance identity: a singleton
    // never needed them, a room of terminals does.
    endpoint: '/',
    label: '',

    // capabilities first-frame (spec v1.7.0). Null until the server
    // sends it; consumers should treat null as "backend hasn't
    // advertised yet" and fall through to defaults.
    capabilities: null,

    // status-update-driven runtime state. turnState ∈
    // {idle, streaming, awaiting_permission, awaiting_elicit}.
    status: {
      model: '',
      provider: '',
      turnState: 'idle',
      contextPct: null,
      permMode: '',
    },

    // Cumulative usage from usage-update events + the per-turn
    // last_turn sub-object (v1.1.1+) with cache attribution.
    usage: {
      tokensIn: 0,
      tokensOut: 0,
      costUSD: 0,
      turns: 0,
      // by_model: { model: { tokensIn, tokensOut, costUSD, turns } }
      byModel: {},
      // last_turn: { tokensIn, tokensInCached, tokensOut, costUSD, model }
      lastTurn: null,
    },

    // The pause gate (spec v1.5.0 §2.8). A paused session is one where
    // no NEW turn starts until someone resumes — which is not the same
    // fact as "no turn is running", because an idle agent picks up the
    // next queued prompt on its own and a paused one does not.
    //
    // Anyone can cause a transition: another browser tab, an embedded
    // TUI, a scheduler, a cost ceiling. So this is state we observe,
    // never state we assume from having sent a request.
    pause: {
      paused: false,
      // RFC 3339 string from the frame, not a Date — banners date from
      // it and it round-trips through JSON unchanged.
      since: null,
      // Shown verbatim; the producer wrote it for an operator to read.
      reason: '',
      // Was a turn actually cancelled on the way in? "Your work was
      // killed" and "the loop just won't start" are different
      // situations and it is the first thing an operator asks.
      interrupted: false,
      // Disposition of the last resume: steer | continue | abandon.
      // Only meaningful after one; '' before.
      resumeMode: '',
    },

    // Last `wake` event (v1.7.0 §2.9), RFC 3339 or null.
    //
    // An edge, not a state — there is no unwake and nothing to
    // reconcile on reconnect. And it does NOT mean an alert is waiting:
    // whatever did the waking announces itself through its own frames.
    // A consumer that renders "you have mail" off this is wrong for
    // every wake that wasn't alert-driven.
    lastWakeAt: null,

    // GET /whoami — who the backend thinks this caller is. Null until
    // someone asks; nobody asks automatically, because it is a second
    // round trip for a fact `capabilities.caller_id` already carries
    // approximately.
    //
    // The difference is what "approximately" hides: caller_id is the
    // identity the token presented, and this is the identity the
    // backend resolved it to, plus `proxy_by` when something signed on
    // this caller's behalf and `admin` when the session can do more
    // than its operator expects. Both of those change what an operator
    // should believe about what they are looking at, and neither is
    // derivable from the first frame.
    //
    // Shape: { identity, source?, proxy_by?, admin? }.
    whoami: null,

    // GET /sessions response, sorted by lastTouchedAt desc.
    sessions: [],

    // turn-error kind=cost_ceiling flips this true; cleared on
    // reconnect / session switch. UI keys off this to disable input
    // + render a persistent banner.
    costCeilingHit: false,

    // inbox event coalesce: { prompt_id: 'queued' | 'dequeued' }.
    // Used to avoid double-firing UI notifications when the same
    // prompt is queued then dequeued in rapid succession.
    inboxState: {},

    // Current session id/model — hoisted out of app.js module scope.
    // Empty when disconnected. currentSession is authoritative for
    // "which session are we attached to"; currentModel mirrors
    // status.model for legacy consumers.
    currentSession: '',
    currentModel: '',

    // Denormalized cumulative counters that used to live as separate
    // module-scope vars in app.js. Kept here rather than derived from
    // usage.turns / usage.costUSD because the UI updates them
    // eagerly on turn-complete (before usage-update arrives). Once
    // rendering is fully subscribe-driven we can derive.
    turnCount: 0,
    totalCostUSD: 0,

    // Set of session ids the operator was told support no interrupt
    // (server 412). Prevents re-showing the Stop button for those
    // sessions on subsequent turns. Stored as an array (Set doesn't
    // serialize well through structured clone / JSON) that consumers
    // check via includes().
    interruptUnsupportedForSession: [],

    // Server-advertised slash commands from capabilities.slash_commands.
    // Merged with the client-owned local set in the palette + /help.
    serverSlashCommands: [],
  };

  // opts seeds the per-instance fields at construction — endpoint,
  // label and currentSession are known before the first frame arrives,
  // and a terminal that had to set them after the fact would render one
  // frame of the wrong prefix.
  function createSession(opts) {
    const cfg = opts || {};
    const initialSessionState = { ...baseSessionState, ...cfg };

    const store = createStore(initialSessionState);

    // ─── Public shape helpers (thin sugar over store.get / set) ────────
    //
    // These wrap the raw store with named actions so callers read like
    // domain code rather than store plumbing. Each returns nothing —
    // subscribers observe via store.subscribe.

    function setCapabilities(caps) {
      store.set({ capabilities: caps });
    }

    function mergeCapabilities(patch) {
      // Deep-merge on `features` so a status-update hot-flag flip
      // doesn't clobber the rest of the map (spec v1.4.0 §status-update
      // merge semantics). Other fields replace.
      const s = store.get();
      const base = s.capabilities || {};
      const merged = { ...base, ...patch };
      if (base.features || patch.features) {
        merged.features = { ...base.features, ...patch.features };
      }
      store.set({ capabilities: merged });
    }

    function patchStatus(patch) {
      const s = store.get();
      store.set({ status: { ...s.status, ...patch } });
    }

    function patchUsage(patch) {
      const s = store.get();
      store.set({ usage: { ...s.usage, ...patch } });
    }

    // A non-object answer (an old server returning `{}` through a
    // permissive proxy, say) is stored as null rather than as an empty
    // object, so "we asked and got nothing" reads the same as "we never
    // asked" — both mean there is no identity to show.
    function setWhoami(who) {
      store.set({ whoami: who && typeof who === 'object' && who.identity ? who : null });
    }

    // ─── The pause gate ────────────────────────────────────────────────
    //
    // Two sources say whether the agent is held, and they disagree for
    // about a second at a time. The `pause` event is the fast one; GET
    // /status is the durable one, and it's the only one that can tell a
    // client attaching to an already-paused session about a transition
    // that happened before it connected.
    //
    // Spec §2.8 settles the conflict: an applied push wins over a
    // contradicting poll for a short settle window, then the server
    // wins again. Both halves matter. Without the window, a poll
    // already in flight across a resume flips the banner back on for a
    // tick. Without the expiry, a client that missed an event stays
    // wrong forever. core-tui uses two seconds; so do we.
    const PAUSE_SETTLE_MS = 2000;
    let lastPushMs = 0;

    // applyPauseEvent consumes a `pause` frame. Unknown `state` values
    // are a no-op rather than a guess — §2.8 reserves the right to add
    // states, and inventing a meaning for one is how a client breaks on
    // a minor bump it was supposed to survive.
    function applyPauseEvent(data) {
      const d = data || {};
      if (d.state !== 'paused' && d.state !== 'resumed') return;
      const paused = d.state === 'paused';
      lastPushMs = Date.now();
      store.set({
        pause: {
          paused,
          // `at` is the transition; on a resume there's no "since" left
          // to hold, so it clears rather than going stale.
          since: paused ? d.at || null : null,
          reason: paused ? d.reason || '' : '',
          // Absent `interrupted` on a paused frame means false — a
          // plain /pause, or an interrupt that landed while idle.
          interrupted: paused ? !!d.interrupted : false,
          resumeMode: paused ? '' : d.mode || '',
        },
      });
    }

    // applyPauseStatus consumes the pause fields of a GET /status poll.
    // Loses to a push applied inside the settle window; authoritative
    // after it.
    function applyPauseStatus(status) {
      const st = status || {};
      // A pre-v1.5.0 backend says nothing about pausing at all. Absent
      // is not "running" — it's no answer, and overwriting observed
      // state with it would clear a banner the server never retracted.
      if (!('paused' in st) && !('turn_state' in st)) return;
      const paused = 'paused' in st ? !!st.paused : st.turn_state === 'paused';
      const s = store.get();
      if (paused !== s.pause.paused && Date.now() - lastPushMs < PAUSE_SETTLE_MS) return;
      store.set({
        pause: {
          paused,
          since: paused ? st.paused_since || s.pause.since || null : null,
          reason: paused ? st.pause_reason || s.pause.reason || '' : '',
          interrupted: paused ? !!st.interrupted : false,
          // A poll reports the gate, not how it last opened; keep what
          // the stream told us rather than blanking it.
          resumeMode: paused ? '' : s.pause.resumeMode,
        },
      });
    }

    // recordWake consumes a `wake` frame (v1.7.0 §2.9). Timestamp only,
    // by design — see the note on lastWakeAt.
    function recordWake(at) {
      store.set({ lastWakeAt: at || null });
    }

    function setSessions(sessions) {
      store.set({ sessions });
    }

    function setCurrentSession(id) {
      store.set({ currentSession: id });
    }

    function setCurrentModel(model) {
      store.set({ currentModel: model });
    }

    function setCostCeilingHit(hit) {
      store.set({ costCeilingHit: hit });
    }

    function recordInbox(promptID, state) {
      if (!promptID) return;
      const s = store.get();
      store.set({ inboxState: { ...s.inboxState, [promptID]: state } });
    }

    function incrementTurnCount() {
      const s = store.get();
      store.set({ turnCount: s.turnCount + 1 });
    }

    function setTotalCostUSD(v) {
      store.set({ totalCostUSD: v });
    }

    // The server's own turn count, when a usage-update carries one. It
    // outranks the local increment rather than adding to it — see the
    // usage-update case in terminal.js for why.
    function setTurnCount(n) {
      store.set({ turnCount: n });
    }

    function setEndpoint(endpoint) {
      store.set({ endpoint: endpoint || '/' });
    }

    function setLabel(label) {
      store.set({ label: label || '' });
    }

    function markInterruptUnsupported(sessionID) {
      if (!sessionID) return;
      const s = store.get();
      if (s.interruptUnsupportedForSession.includes(sessionID)) return;
      store.set({
        interruptUnsupportedForSession: [...s.interruptUnsupportedForSession, sessionID],
      });
    }

    function interruptUnsupportedFor(sessionID) {
      return store.get().interruptUnsupportedForSession.includes(sessionID);
    }

    function setServerSlashCommands(names) {
      store.set({ serverSlashCommands: Array.isArray(names) ? names.slice() : [] });
    }

    return {
      store,
      // Sugar for the common read — every consumer wants the value, not
      // the store handle.
      get() {
        return store.get();
      },
      subscribe(fn) {
        return store.subscribe(fn);
      },
      // Named actions
      setCapabilities,
      mergeCapabilities,
      patchStatus,
      patchUsage,
      setWhoami,
      applyPauseEvent,
      applyPauseStatus,
      recordWake,
      setSessions,
      setCurrentSession,
      setCurrentModel,
      setCostCeilingHit,
      recordInbox,
      incrementTurnCount,
      setTotalCostUSD,
      setTurnCount,
      setEndpoint,
      setLabel,
      markInterruptUnsupported,
      interruptUnsupportedFor,
      setServerSlashCommands,
      // For tests + reset-on-switch flows.
      initialSessionState,
    };
  }

  // The shape every instance starts from, for tests that assert on it
  // without building one.
  createSession.baseSessionState = baseSessionState;

  return createSession;
})();

// The classic shell's instance. app.js reaches for MastState.session
// directly and predates the factory; it goes away with index.html.
window.MastState.session = window.MastState.createSession();
