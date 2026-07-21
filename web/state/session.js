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
//   - usage totals + per-model breakdown + last-turn cost with cache
//     attribution
//   - sessions list (from GET /sessions; includes idle/active status)
//   - cost-ceiling banner state
//   - inbox coalesce state (queued/dequeued per prompt_id)
//   - current session id + model
//   - server-advertised slash commands
//
// Reducers live in state/session-reducers.js (small pure functions
// that take the current state + an event and return the next state).
// Splitting keeps this file the "data shape" contract and moves the
// "how to update" logic where it can be unit-tested cleanly.
//
// Initial value matches what app.js used to hold in `latest` + a few
// other module-scope vars — this refactor is behavior-preserving.

window.MastState = window.MastState || {};

window.MastState.session = (function () {
  'use strict';

  if (!window.MastState.subscriptions) {
    throw new Error('state/session.js: subscriptions must load first');
  }
  const { createStore } = window.MastState.subscriptions;

  const initialSessionState = {
    // capabilities first-frame (spec v1.4.0). Null until the server
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
    // Named actions
    setCapabilities,
    mergeCapabilities,
    patchStatus,
    patchUsage,
    setSessions,
    setCurrentSession,
    setCurrentModel,
    setCostCeilingHit,
    recordInbox,
    incrementTurnCount,
    setTotalCostUSD,
    markInterruptUnsupported,
    interruptUnsupportedFor,
    setServerSlashCommands,
    // For tests + reset-on-switch flows.
    initialSessionState,
  };
})();
