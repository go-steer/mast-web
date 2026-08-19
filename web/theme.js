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

// MastTheme — the theme registry and the <select> that drives it.
//
// Every shell paints from the same palette contract in styles.css: a
// theme is a `body[data-theme]` block plus an entry in a list, and the
// choice is one localStorage key so a theme picked in one shell is the
// theme the next one opens with.
//
// The list is still duplicated *once* — app.js carries its own copy for
// index.html's /theme command, because index.html is frozen and has no
// way to gain a <script> tag for this file. Every other shell shares
// this one, so the duplication is a single known pair rather than a
// copy per page. Adding a theme means editing styles.css, this list,
// and app.js's THEMES.
window.MastTheme = (function () {
  'use strict';

  const KEY = 'mast-web:theme';

  const THEMES = [
    { id: 'default', label: 'Go brand' },
    { id: 'grayscale-dark', label: 'Google grayscale · dark' },
    { id: 'grayscale-light', label: 'Google grayscale · light' },
    { id: 'cloud-light', label: 'Google Cloud · light' },
    { id: 'pantheon-light', label: 'Google Pantheon · light' },
    { id: 'pantheon-dark', label: 'Google Pantheon · dark' },
    { id: 'solarized-dark', label: 'Solarized dark' },
    { id: 'solarized-light', label: 'Solarized light' },
    { id: 'high-contrast', label: 'High contrast' },
    { id: 'mono', label: 'Monochrome' },
    { id: 'paper', label: 'Paper' },
  ];

  function known(id) {
    return THEMES.some(function (t) {
      return t.id === id;
    });
  }

  // 'default' is the absence of the attribute rather than a value of
  // it, so the :root block in styles.css stays the one place the Go
  // brand palette is written down.
  function apply(id) {
    if (id && id !== 'default') document.body.setAttribute('data-theme', id);
    else document.body.removeAttribute('data-theme');
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* blocked storage — the choice still holds for this visit */
    }
  }

  function current() {
    let id = 'default';
    try {
      id = localStorage.getItem(KEY) || 'default';
    } catch {
      /* private mode — Go brand it is */
    }
    // A theme removed from the list (or a hand-edited key) must not
    // leave the shell with a data-theme nothing styles.
    return known(id) ? id : 'default';
  }

  // Fills a <select> with the registry, selects the stored theme,
  // applies it, and keeps the two in step from then on.
  function mount(selectEl) {
    const id = current();
    if (selectEl) {
      THEMES.forEach(function (t) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        selectEl.appendChild(opt);
      });
      selectEl.value = id;
      selectEl.addEventListener('change', function () {
        apply(selectEl.value);
      });
    }
    apply(id);
    return id;
  }

  return { THEMES: THEMES, apply: apply, current: current, mount: mount };
})();
