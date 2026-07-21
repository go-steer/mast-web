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

// state/daemons — placeholder observable store for the multi-daemon
// registry. v0.3.0 PR 2 (mast-web#22) fills this in with:
//   - per-daemon AttachClient instances keyed by endpoint URL
//   - GET /peers-driven auto-discovery
//   - sidebar aggregation across daemons with per-daemon badges
//   - Add-daemon dialog + localStorage persistence
//
// For v0.3.0 PR 1 (this refactor), the shape is single-daemon so
// nothing above the store changes visibly. Keeping the store file
// here means PR 2 doesn't need to touch state-layer wiring — just
// fill in the reducers + action helpers.

window.MastState = window.MastState || {};

window.MastState.daemons = (function () {
  'use strict';

  if (!window.MastState.subscriptions) {
    throw new Error('state/daemons.js: subscriptions must load first');
  }
  const { createStore } = window.MastState.subscriptions;

  // Single-daemon placeholder shape. PR 2 replaces with:
  //   daemons: { [endpoint]: { client, prompter, sessions[], alias, addedAt, lastError } }
  //   activeDaemon: <endpoint>
  const initialDaemonsState = {
    // Empty for v0.3.0 PR 1. The current single-daemon setup is
    // still tracked via connection.client — daemons.js won't be
    // consulted by anyone until PR 2.
    daemons: {},
    activeDaemon: '',
  };

  const store = createStore(initialDaemonsState);

  return {
    store,
    initialDaemonsState,
  };
})();
