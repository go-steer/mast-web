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

// state/connection — observable store for the SPA's connection to a
// backend. Owns the connection state machine + a reference to the
// live AttachClient + Prompter (when connected).
//
// State machine values match what the status-bar CSS keys off:
//   'disconnected' | 'connecting' | 'connected' | 'terminal'
//
// 'terminal' is the PermanentStreamError state (404/401/403 on the
// SSE reconnect); the SPA stops retrying and shows a banner. That's
// new terminology relative to the pre-refactor `connected` bool —
// nothing shipped uses the string 'terminal' yet, but wiring it
// through the store now lets future PRs surface it in the UI without
// re-touching this file.
//
// One instance per connection, not one per page: a room with four
// terminals has four of these. `createConnection()` is the factory;
// `MastState.connection` is the classic shell's single instance.
//
// This shape is already exactly what terminal.js had grown informally
// in its own closure — connState / running / prompter / activeTurn —
// which is the clearest evidence that the seam was right and only its
// singleton-ness was wrong.

window.MastState = window.MastState || {};

window.MastState.createConnection = (function () {
  'use strict';

  if (!window.MastState.subscriptions) {
    throw new Error('state/connection.js: subscriptions must load first');
  }
  const { createStore } = window.MastState.subscriptions;

  const baseConnectionState = {
    state: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'terminal'
    // Live client refs. Stored on the store rather than as
    // module-scope vars so the observer wiring in future PRs can
    // subscribe to connection changes and react (e.g. re-open the
    // perms stream on reconnect).
    client: null,
    prompter: null,
    // isRunning is transient turn state — no one subscribes to it,
    // but living here keeps app.js from carrying orphaned globals.
    isRunning: false,
    // Active turn dispatch handle used by runPrompt to route SSE
    // events back to the render callbacks. Null when idle. Same
    // caveat as isRunning re subscribers; here for locality.
    activeTurn: null,
  };

  function createConnection(opts) {
    const initialConnectionState = { ...baseConnectionState, ...(opts || {}) };

    const store = createStore(initialConnectionState);

    // ─── Named actions ────────────────────────────────────────────────

    function setState(state) {
      store.set({ state });
    }

    function setClient(client) {
      store.set({ client });
    }

    function setPrompter(prompter) {
      store.set({ prompter });
    }

    function setIsRunning(v) {
      store.set({ isRunning: !!v });
    }

    function setActiveTurn(t) {
      store.set({ activeTurn: t });
    }

    // Convenience getters used by dispatchers that need to make routing
    // decisions without opening the whole state.
    function isConnected() {
      return store.get().state === 'connected';
    }

    function isRunning() {
      return store.get().isRunning;
    }

    function getClient() {
      return store.get().client;
    }

    function getPrompter() {
      return store.get().prompter;
    }

    function getActiveTurn() {
      return store.get().activeTurn;
    }

    return {
      store,
      get() {
        return store.get();
      },
      subscribe(fn) {
        return store.subscribe(fn);
      },
      getState() {
        return store.get().state;
      },
      setState,
      setClient,
      setPrompter,
      setIsRunning,
      setActiveTurn,
      isConnected,
      isRunning,
      getClient,
      getPrompter,
      getActiveTurn,
      initialConnectionState,
    };
  }

  createConnection.baseConnectionState = baseConnectionState;

  return createConnection;
})();

// The classic shell's instance — see the note in state/session.js.
window.MastState.connection = window.MastState.createConnection();
