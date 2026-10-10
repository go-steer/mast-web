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

// shell-select — everything index.html does now.
//
// Not to be confused with shell.js (MastShell), which is the *inside*
// of a shell: its commands and overlays. This file runs on `/` and does
// one thing, once: decide which of the two documents the operator meant
// and go there. It loads no stores, no client, no stylesheet.
//
// It is a separate file rather than an inline <script> because the CSP
// on index.html is `script-src 'self'` with no 'unsafe-inline' — the
// page that chooses a shell holds no credentials itself, but it is the
// front door to two that do, and a front door with looser rules than
// the rooms behind it is how the rules stop meaning anything.
//
// Precedence (v0.4 plan §1):
//
//   1. ?shell=solo | ?shell=spatial — deep links and smoke specs.
//   2. localStorage['mast-web:shell'] — operator preference, written by
//      the HUD link in each shell (see shell.js).
//   3. solo — the surface that works on a laptop trackpad, in a narrow
//      window, and for someone who has never orbited a 3D room.
//      spatial is the one you choose.
//
// A ?shell= deep link deliberately does NOT become the stored
// preference. Sending someone a link to the room should not re-home
// them there, and the smoke suite opens both shells in one run.
//
// A ?shell= this page doesn't recognise — `spacial` — does NOT fall
// through to 2 and 3 (#120). Landing in solo anyway reads as "the deep
// link is broken", the opposite of the truth. Instead the page stays,
// shows the no-JS list it already has, and names the value it didn't
// understand. An empty ?shell= is no value, not an unknown one.
(function () {
  'use strict';

  const KEY = 'mast-web:shell';
  const SHELLS = { solo: 'solo.html', spatial: 'spatial.html' };

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      // Blocked storage (private mode, third-party iframe): the
      // default is still a working answer.
      return null;
    }
  }

  const params = new URLSearchParams(window.location.search);
  const asked = params.get('shell');
  const saved = stored();
  const known = (id) => Object.prototype.hasOwnProperty.call(SHELLS, id);

  // Everything else in the query string belongs to the shell, not to
  // this page — ?fixture= in particular, which the smoke suite hands
  // through to the mock. The hash rides along untouched.
  params.delete('shell');
  const qs = params.toString();
  const target = (id) => SHELLS[id] + (qs ? '?' + qs : '') + window.location.hash;

  if (asked && !known(asked)) {
    // This runs in <head>, before the page it fills in exists.
    document.addEventListener('DOMContentLoaded', () => {
      const pick = document.getElementById('shell-pick');
      if (pick) {
        // textContent: the value is whatever was in the URL.
        pick.textContent = 'There is no shell called "' + asked + '". Pick one:';
        pick.setAttribute('role', 'alert');
      }
      // The links keep the rest of the query string, as the redirect
      // would have.
      document.querySelectorAll('a[data-shell]').forEach((a) => {
        const id = a.getAttribute('data-shell');
        if (known(id)) a.setAttribute('href', target(id));
      });
    });
    return;
  }

  const id = known(asked) ? asked : known(saved) ? saved : 'solo';
  window.location.replace(target(id));
})();
