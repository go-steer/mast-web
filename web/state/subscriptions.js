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

// state/subscriptions — tiny observable-store primitive. Vanilla JS,
// zero deps, ~30 LOC of real code. Matches the project's ethos of
// building the smallest thing that solves the problem instead of
// pulling in Redux / Zustand / Preact-signals / etc.
//
// Contract:
//   createStore(initial)
//     initial — any value (typically a plain object). Stored as-is;
//               reducers are expected to return NEW values rather
//               than mutate. Subscribers see the value returned by
//               the most recent set() call.
//
//     returns {
//       get()            — current value, no defensive copy
//       set(patchOrFn)   — replace with the merged patch (object) or
//                          the return value of patchOrFn(currentValue).
//                          Fires listeners synchronously; catch throws
//                          in each listener so one bad subscriber
//                          doesn't break the others.
//       subscribe(fn)    — call fn(value) on every set(). Returns an
//                          unsubscribe function.
//       reset()          — restore the initial value + fire listeners.
//                          Useful in tests and on session switch.
//     }
//
// Design notes:
//
//   Object patches use shallow-merge (Object.assign spread). Nested
//   updates need the function form to control depth explicitly.
//
//   Listeners fire synchronously in insertion order. Not throttled /
//   batched — the SPA doesn't render often enough for it to matter.
//   If batching becomes a papercut, revisit with requestAnimationFrame
//   or microtask scheduling then; not now.
//
//   No middleware / no time-travel / no DevTools integration. The
//   whole surface is get / set / subscribe / reset. When the app
//   grows to need more, that's a signal to reach for a real library,
//   not to inline more machinery here.

window.MastState = window.MastState || {};

window.MastState.subscriptions = (function () {
  'use strict';

  function createStore(initial) {
    let value = initial;
    const listeners = new Set();

    function notify() {
      for (const fn of listeners) {
        try {
          fn(value);
        } catch (e) {
          // A misbehaving subscriber shouldn't take down the whole
          // fan-out. Log and continue.
          console.error('state/subscriptions: listener threw', e);
        }
      }
    }

    return {
      get() {
        return value;
      },
      set(patchOrFn) {
        if (typeof patchOrFn === 'function') {
          value = patchOrFn(value);
        } else if (
          patchOrFn &&
          typeof patchOrFn === 'object' &&
          value &&
          typeof value === 'object'
        ) {
          // Shallow merge — common case for object state.
          value = { ...value, ...patchOrFn };
        } else {
          value = patchOrFn;
        }
        notify();
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      reset() {
        value = initial;
        notify();
      },
    };
  }

  return { createStore };
})();
