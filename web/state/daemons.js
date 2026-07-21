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

// state/daemons — per-daemon AttachClient registry for the multi-
// daemon fan-out (v0.3.0 PR 2, mast-web#22). Each entry represents
// one operator-added backend daemon; the SPA holds a live SSE
// connection to each in parallel and aggregates their sessions in
// the sidebar. Cross-daemon session switch is instant — no reconnect
// — because both stay attached.
//
// Ports the coretuiremote pattern (internal/coretuiremote/
// capabilities.go:498-608): local rows + peer rows in a single
// sidebar, peer-tagged for provenance.

window.MastState = window.MastState || {};

window.MastState.daemons = (function () {
  'use strict';

  if (!window.MastState.subscriptions) {
    throw new Error('state/daemons.js: subscriptions must load first');
  }
  const { createStore } = window.MastState.subscriptions;

  // Store shape:
  //   daemons: { [endpoint]: {
  //     endpoint,        // canonical URL (post-normalization)
  //     token,           // bearer or ''
  //     alias,           // short label for badges ("prod", "peer-1", etc.)
  //     addedAt,         // ISO timestamp of first add (for stable ordering)
  //     state,           // 'disconnected' | 'connecting' | 'connected' | 'terminal'
  //     lastError,       // human-readable most-recent error (or '')
  //     sessions,        // last-known session list from listSessions()
  //     // Live refs — not persisted; set on connect(), cleared on remove().
  //     client, prompter,
  //   } }
  //   activeDaemon: <endpoint>   // whose SSE currently paints the transcript
  //
  // The client/prompter refs are stored here so the sidebar+router
  // can reach a specific daemon's handles without a parallel map.
  // Not persisted (localStorage carries endpoint/token/alias only —
  // refs rehydrate on boot via addDaemon-then-connect).
  const initialDaemonsState = {
    daemons: {},
    activeDaemon: '',
  };

  const store = createStore(initialDaemonsState);

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

  function byAddedAt(a, b) {
    const ta = a.addedAt ? Date.parse(a.addedAt) : 0;
    const tb = b.addedAt ? Date.parse(b.addedAt) : 0;
    if (ta !== tb) return ta - tb;
    return (a.endpoint || '').localeCompare(b.endpoint || '');
  }

  return {
    store,
    addDaemon,
    patchDaemon,
    removeDaemon,
    setActiveDaemon,
    getDaemon,
    getActiveDaemon,
    listDaemons,
    initialDaemonsState,
  };
})();
