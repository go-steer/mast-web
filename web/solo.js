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

// mast-web // solo shell — one terminal, full size, in the spatial
// shell's chrome.
//
// The room is a good answer to "what are all my agents doing"; it is a
// worse answer to "I am working with this one". This shell keeps what
// makes the spatial terminals read as real terminals — the bezel, the
// power-on, the screen frame, the scanlines, the damage states — drops
// the camera, and gives the frame a tab strip so several sessions can
// be open without any of them being small.
//
// It is not a fork of the room: the panel chrome is spatial.css, the
// terminal is terminal.js, the daemon registry is state/daemons.js and
// the sidebar over it is daemon-sidebar.js, the theme list is theme.js.
// What lives here is the tab model and the wiring, which is the only
// part that differs.
//
// index.html (the classic shell) is untouched and stays the
// feature-complete one — app.js still carries the client-side slash
// commands, the model picker, session export and the batch runner that
// terminal.js hasn't been given yet.
(function () {
  'use strict';

  const stage = document.getElementById('solo-stage');
  const anchor = document.getElementById('solo-anchor');
  const panel = document.getElementById('solo-panel');
  const body = document.getElementById('solo-body');
  const empty = document.getElementById('solo-empty');
  const tabStrip = document.getElementById('solo-tabs');
  const hudCount = document.getElementById('hud-count');
  const statusFocus = document.getElementById('status-focus');
  const statusClock = document.getElementById('status-clock');
  const daemonList = document.getElementById('daemon-list');

  // The same four slots the room hands its panels, in the same order,
  // so a session that was the blue terminal over there is the blue tab
  // over here.
  const HUES = ['--hue-1', '--hue-2', '--hue-3', '--hue-4'];

  // Tracks panel-boot's duration in spatial.css, plus a frame of slack.
  const BOOT_MS = 700;

  // Long enough for the flash to read as a cut, short enough that it
  // never delays the transcript you asked for.
  const SWITCH_MS = 170;

  const tabs = new Map();
  let selected = null;
  let spawnCount = 0;
  let switchTimer = 0;

  function keyFor(endpoint, sessionId) {
    return endpoint + '#' + sessionId;
  }

  // ─── The frame ─────────────────────────────────────────────────────
  // One panel, wearing whichever tab is in front: its hue, its
  // connection state, its damage. Everything here is a repaint of the
  // shared chrome, never a rebuild — the terminals stay mounted.

  function paintFrame() {
    const t = selected;
    panel.style.setProperty('--hue', 'var(' + HUES[(t ? t.index : 0) % HUES.length] + ')');
    panel.style.setProperty(
      '--hue-next',
      'var(' + HUES[((t ? t.index : 0) + 1) % HUES.length] + ')'
    );
    panel.dataset.conn = t ? t.term.state.connState : 'disconnected';
    panel.classList.toggle('panel-dead', !!t && t.dead);
    panel.classList.toggle('panel-busy', !!t && t.term.state.running);
    empty.hidden = !!t;
    statusFocus.textContent = 'active: ' + (t ? t.title : '—');
    hudCount.textContent = tabs.size === 1 ? '1 session' : tabs.size + ' sessions';
  }

  function renderTabs() {
    tabStrip.replaceChildren();
    tabs.forEach(function (t) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'solo-tab';
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', t === selected ? 'true' : 'false');
      el.classList.toggle('busy', t.term.state.running);
      el.classList.toggle('dead', t.dead);
      el.title = t.session.id + ' · ' + t.daemon.endpoint;
      el.style.setProperty('--tab-hue', 'var(' + HUES[t.index % HUES.length] + ')');

      const dot = document.createElement('span');
      dot.className = 'solo-tab-dot';
      const name = document.createElement('span');
      name.className = 'solo-tab-name';
      name.textContent = t.title;
      el.append(dot, name);

      const close = document.createElement('span');
      close.className = 'solo-tab-close';
      close.textContent = '×';
      close.setAttribute('role', 'button');
      close.title = 'Close ' + t.title;
      close.addEventListener('click', function (e) {
        e.stopPropagation();
        closeTab(t);
      });
      el.appendChild(close);

      el.addEventListener('click', function () {
        select(t);
      });
      t.el = el;
      tabStrip.appendChild(el);
    });
  }

  function repaint() {
    paintFrame();
    renderTabs();
    agents.render();
  }

  // ─── Tabs ──────────────────────────────────────────────────────────

  function select(t, opts) {
    if (!t || t === selected) {
      if (t) t.term.focusInput();
      return;
    }
    if (selected) selected.term.el.hidden = true;
    selected = t;
    t.term.el.hidden = false;
    if (!opts || opts.flash !== false) flashSwitch();
    repaint();
    // The transcript was laid out while display:none, so its scroller
    // has no idea where the bottom is until it has been on screen for a
    // frame.
    window.requestAnimationFrame(function () {
      t.term.reflow();
      t.term.focusInput();
    });
    saveTabs();
  }

  function flashSwitch() {
    anchor.classList.remove('switching');
    // Force the class change to land as two separate styles, or the
    // animation restarts from wherever it was rather than from zero.
    void anchor.offsetWidth;
    anchor.classList.add('switching');
    window.clearTimeout(switchTimer);
    switchTimer = window.setTimeout(function () {
      anchor.classList.remove('switching');
    }, SWITCH_MS);
  }

  // opts.focus === false opens the tab in the background, which is what
  // "open all" wants; opts.index pins the hue slot a restored tab had.
  function open(daemon, session, opts) {
    const key = keyFor(daemon.endpoint, session.id);
    const existing = tabs.get(key);
    if (existing) {
      if (!opts || opts.focus !== false) select(existing);
      return existing;
    }

    const index = opts && Number.isInteger(opts.index) ? opts.index : spawnCount;
    spawnCount = Math.max(spawnCount, index + 1);
    const title = (session.app ? session.app + ' // ' : '') + session.id;

    // Declared before create(): MastTerminal.create calls onChange
    // synchronously while it builds (it seeds the status line with
    // 'disconnected'), so a `const t` below would still be in its
    // temporal dead zone when the callback first runs.
    let t = null;

    const term = window.MastTerminal.create({
      endpoint: daemon.endpoint,
      token: daemon.token,
      sessionId: session.id,
      label: title,
      onChange: function () {
        if (!t) return;
        // A terminal reports 'disconnected' from the moment it is built,
        // before connect() has been anywhere, so damage has to wait for
        // the boot window to close — otherwise every tab opens broken
        // for half a second. Same gate the room uses.
        t.dead = t.booted && !t.closing && term.state.connState === 'disconnected';
        repaint();
      },
    });

    t = {
      key: key,
      index: index,
      title: title,
      daemon: daemon,
      session: session,
      term: term,
      el: null,
      booted: false,
      dead: false,
      closing: false,
    };
    tabs.set(key, t);

    term.el.hidden = true;
    body.appendChild(term.el);

    const focus = !opts || opts.focus !== false;
    if (focus) {
      // Power-on, but only when the screen is actually about to show
      // this session. Booting the frame for a background tab would
      // flash the transcript the operator is reading.
      anchor.classList.add('booting');
      window.setTimeout(function () {
        anchor.classList.remove('booting');
      }, BOOT_MS);
      select(t, { flash: false });
    } else {
      repaint();
    }

    window.setTimeout(function () {
      t.booted = true;
    }, BOOT_MS);

    term.connect().catch(function () {
      // connect() already painted the failure into the transcript.
    });

    saveTabs();
    return t;
  }

  function closeTab(t) {
    if (!t || !tabs.has(t.key)) return;
    // Set before destroy(): tearing the client down reports a
    // disconnect, and onChange must not read that as damage.
    t.closing = true;
    const order = Array.from(tabs.values());
    const at = order.indexOf(t);
    t.term.destroy();
    tabs.delete(t.key);
    if (selected === t) {
      selected = null;
      const next = order[at + 1] || order[at - 1] || null;
      if (next && tabs.has(next.key)) select(next, { flash: false });
    }
    repaint();
    saveTabs();
  }

  function openAll(d) {
    const claim = !selected;
    d.sessions.forEach(function (s, i) {
      open(d, s, { focus: claim && i === 0 });
    });
  }

  function step(delta) {
    const order = Array.from(tabs.values());
    if (order.length === 0) return;
    const at = selected ? order.indexOf(selected) : -1;
    const next = order[(at + delta + order.length) % order.length];
    select(next);
  }

  // ─── Persistence ───────────────────────────────────────────────────
  // Which sessions were open, in which slots, and which one was in
  // front. Restored per daemon as its session list lands, so a session
  // that has gone away upstream is dropped rather than reopened against
  // a dead id.

  const TABS_KEY = 'mast-web:solo-tabs';
  const saved = readTabs();
  const pending = new Set();
  let restoring = false;
  let saveTimer = 0;

  if (saved) {
    saved.tabs.forEach(function (r) {
      pending.add(r.endpoint);
    });
  }

  function readTabs() {
    try {
      const raw = localStorage.getItem(TABS_KEY);
      const data = raw ? JSON.parse(raw) : null;
      if (!data || !Array.isArray(data.tabs) || data.tabs.length === 0) return null;
      return data;
    } catch {
      return null;
    }
  }

  function writeTabs() {
    const rows = [];
    tabs.forEach(function (t) {
      rows.push({
        endpoint: t.daemon.endpoint,
        id: t.session.id,
        app: t.session.app || '',
        index: t.index,
      });
    });
    // A daemon that hasn't answered yet still has rows worth keeping —
    // dropping them here is what would lose the layout on a reload
    // while the backend is restarting.
    if (saved && pending.size) {
      const live = new Set(
        rows.map(function (r) {
          return r.endpoint + '#' + r.id;
        })
      );
      saved.tabs.forEach(function (r) {
        if (pending.has(r.endpoint) && !live.has(r.endpoint + '#' + r.id)) rows.push(r);
      });
    }
    try {
      localStorage.setItem(
        TABS_KEY,
        JSON.stringify({
          tabs: rows,
          active: selected ? selected.key : pending.size && saved ? saved.active : null,
        })
      );
    } catch {
      /* blocked storage — the tabs are still live in memory */
    }
  }

  function saveTabs() {
    // Opening four tabs writes four times otherwise, and the last write
    // is the only one that matters.
    if (restoring) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(writeTabs, 250);
  }

  function restoreInto(d) {
    if (!saved || !pending.has(d.endpoint) || d.state !== 'connected') return;
    pending.delete(d.endpoint);

    const mine = saved.tabs.filter(function (r) {
      return r.endpoint === d.endpoint;
    });
    if (mine.length === 0) return;

    restoring = true;
    let toFocus = null;
    mine.forEach(function (r) {
      const session = d.sessions.find(function (s) {
        return s.id === r.id;
      });
      if (!session) return;
      const t = open(d, session, { focus: false, index: r.index });
      if (t && saved.active === t.key) toFocus = t;
    });
    restoring = false;

    if (toFocus) select(toFocus, { flash: false });
    else if (!selected && tabs.size) select(tabs.values().next().value, { flash: false });
  }

  // ─── Daemons ───────────────────────────────────────────────────────

  const agents = window.MastDaemonSidebar.create({
    listEl: daemonList,
    onOpen: open,
    onOpenAll: openAll,
    onDetach: function (d) {
      tabs.forEach(function (t) {
        if (t.daemon.endpoint === d.endpoint) closeTab(t);
      });
    },
    onRefreshed: restoreInto,
    sessionState: function (d, s) {
      const t = tabs.get(keyFor(d.endpoint, s.id));
      return { open: !!t, active: !!t && t === selected };
    },
  });

  // ─── Wiring ────────────────────────────────────────────────────────

  document.getElementById('btn-refresh').addEventListener('click', agents.refreshAll);

  document.getElementById('btn-close').addEventListener('click', function () {
    if (selected) closeTab(selected);
  });

  document.getElementById('btn-sidebar').addEventListener('click', function () {
    document.body.classList.toggle('side-hidden');
    // The stage just changed width; the transcript's scroller has to be
    // re-pinned once the slide has settled.
    window.setTimeout(function () {
      if (selected) selected.term.reflow();
    }, 300);
  });

  document.getElementById('add-daemon').addEventListener('submit', function (e) {
    e.preventDefault();
    const epEl = document.getElementById('add-endpoint');
    const tokEl = document.getElementById('add-token');
    const d = agents.add(epEl.value, tokEl.value);
    tokEl.value = '';
    agents.refresh(d);
  });

  // Alt rather than Ctrl or Cmd: ctrl+1…9 and cmd+1…9 are the browser's
  // own tab switcher and never reach the page, and ctrl/cmd+W closes the
  // window.
  //
  // Every branch preventDefault()s whether or not it had somewhere to
  // go. On macOS, Option is a compose key — option+2 types "™",
  // option+w types "∑" — and the prompt has focus essentially always,
  // so a shortcut that only claims the keystroke when it happens to hit
  // would dribble symbols into the input box the rest of the time.
  //
  // e.code, not e.key: with Option held, macOS reports the composed
  // character in e.key, so `e.key === 'w'` is never true there.
  window.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      e.preventDefault();
      select(Array.from(tabs.values())[Number(digit[1]) - 1]);
      return;
    }
    if (e.code === 'BracketLeft') {
      e.preventDefault();
      step(-1);
    } else if (e.code === 'BracketRight') {
      e.preventDefault();
      step(1);
    } else if (e.code === 'KeyW') {
      e.preventDefault();
      if (selected) closeTab(selected);
    }
  });

  window.setInterval(function () {
    statusClock.textContent = new Date().toLocaleTimeString('en-GB');
  }, 1000);

  window.addEventListener('resize', function () {
    if (selected) selected.term.reflow();
  });

  window.addEventListener('pagehide', function () {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
    writeTabs();
  });

  // The stage is a fixed-size viewport, never a scrolling document, so
  // a restored scroll offset can only ever push the HUD off the top.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  window.MastTheme.mount(document.getElementById('hud-theme'));
  paintFrame();

  agents.boot().then(function (endpoints) {
    const registered = new Set(endpoints);
    // Rows for a daemon that is no longer attached have nothing left to
    // wait for; disarm them so they stop being carried forward.
    pending.forEach(function (endpoint) {
      if (!registered.has(endpoint)) pending.delete(endpoint);
    });
    // Offer the attach form the path this deployment actually serves,
    // rather than the same-origin default in the markup — behind a BFF
    // that default is the one address that is certainly wrong.
    const found = agents.site();
    if (found && found.endpoint) document.getElementById('add-endpoint').value = found.endpoint;
  });

  // ─── Public seam ───────────────────────────────────────────────────
  window.MastSolo = {
    tabs: tabs,
    // A getter, for the same reason spatial.js uses one: registry
    // records are immutable, so a Map captured at load goes stale the
    // first time a daemon finishes listing.
    get daemons() {
      return agents.daemons;
    },
    registry: agents.registry,
    open: open,
    openAll: openAll,
    select: select,
    close: closeTab,
    selected: function () {
      return selected;
    },
    refreshAll: agents.refreshAll,
    stage: stage,
  };
})();
