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
  const id = SHELLS[asked] ? asked : SHELLS[saved] ? saved : 'solo';

  // Everything else in the query string belongs to the shell, not to
  // this page — ?fixture= in particular, which the smoke suite hands
  // through to the mock. The hash rides along untouched.
  params.delete('shell');
  const qs = params.toString();
  window.location.replace(SHELLS[id] + (qs ? '?' + qs : '') + window.location.hash);
})();
