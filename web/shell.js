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

// MastShell — the things that belong to the window rather than to any
// one terminal: the command palette, the session picker, the
// keyboard-shortcuts overlay, the batch runner, and the slash commands
// that drive them.
//
// This is the other half of the v0.4 capability port (#60, PR 3b).
// terminal.js took everything that acts on a session; everything that
// acts on the shell around it is here, because a panel cannot sensibly
// own the theme of the page it is drawn on, and four panels each owning
// it would be four answers to one question.
//
// Both surviving shells mount one of these. The classic shell had grown
// its own copies of all of it inside app.js, keyed to that page's markup —
// which is why the overlays here build their own DOM rather than
// reaching for ids: solo.html and spatial.html should not have to carry
// four modals in their markup to gain a palette, and a shell that
// forgets one of the divs should not be a shell with a broken palette.
//
// The commands are handed to MastTerminal.create as `commands`, so they
// land in the same table as the built-ins: /help lists them, the
// capability gate covers them, and the palette reads the merged table
// back out of the terminal rather than keeping a list of its own. That
// single read is the whole point of #45 — a name that is offered and a
// name that will run have to be the same set.
//
// Requires: state/daemons.js (via the sidebar), terminal.js, theme.js,
// and .modal / .palette-item / #batch-* styles from styles.css.
//
//   const shell = MastShell.create({ sidebar, activeTerminal, openSession });
//   MastTerminal.create({ …, commands: shell.commands });
window.MastShell = (function () {
  'use strict';

  // ─── Layout ────────────────────────────────────────────────────────
  //
  // Orthogonal to the theme: /theme is colour, /layout is arrangement,
  // and they compose. Two transcript layouts, applied as a body
  // attribute the same way themes are, and persisted under the key the
  // classic shell already used, so a layout chosen there survived the
  // walk over here — and survived app.js being deleted.
  //
  // `log` is the attribute-less default because the console restyle
  // made it the house style; `chat` is the opt-in. The rules live in
  // styles.css under /* Layouts */ and key off `.message.user`, which
  // every shell's transcript produces.

  const LAYOUT_KEY = 'mast-web:layout';

  const LAYOUTS = [
    { id: 'log', label: 'Log — left-aligned terminal transcript' },
    { id: 'chat', label: 'Chat — right-aligned user turns' },
  ];

  function knownLayout(id) {
    return LAYOUTS.some(function (l) {
      return l.id === id;
    });
  }

  function applyLayout(id) {
    const chosen = knownLayout(id) ? id : 'log';
    if (chosen === 'log') document.body.removeAttribute('data-layout');
    else document.body.setAttribute('data-layout', chosen);
    try {
      localStorage.setItem(LAYOUT_KEY, chosen);
    } catch {
      /* blocked storage — the choice still holds for this visit */
    }
    return chosen;
  }

  function currentLayout() {
    return document.body.getAttribute('data-layout') || 'log';
  }

  function storedLayout() {
    try {
      return localStorage.getItem(LAYOUT_KEY) || 'log';
    } catch {
      return 'log';
    }
  }

  // ─── Which shell ───────────────────────────────────────────────────
  //
  // The document at `/` reads this key and sends the operator to one of
  // the two shells (web/shell-select.js, v0.4 plan §1). Nothing here
  // switches shells by itself — a shell is a document, so switching is
  // a navigation — but the HUD link that performs it should leave a
  // record, or "remember where I work" would mean "retype ?shell= every
  // morning".
  //
  // Written on the way out rather than on arrival. Storing it at mount
  // would make the last page you happened to land on the preference,
  // including one reached from a link someone sent you.

  const SHELL_KEY = 'mast-web:shell';

  const SHELLS = [
    { id: 'solo', href: 'solo.html', label: 'Solo — one terminal, full size' },
    { id: 'spatial', href: 'spatial.html', label: 'Spatial — a room of terminals' },
  ];

  function shellByID(id) {
    return (
      SHELLS.filter(function (s) {
        return s.id === id;
      })[0] || null
    );
  }

  function rememberShell(id) {
    if (!shellByID(id)) return null;
    try {
      localStorage.setItem(SHELL_KEY, id);
    } catch {
      /* blocked storage — the navigation still happens */
    }
    return id;
  }

  function preferredShell() {
    try {
      return localStorage.getItem(SHELL_KEY) || 'solo';
    } catch {
      return 'solo';
    }
  }

  // ─── Small shared helpers ──────────────────────────────────────────

  function mk(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // A one-column list of `id  label`, with the current one marked. Used
  // by /theme and /layout, which are the same command over different
  // registries.
  function listRegistry(title, rows, currentId, usage) {
    const width = rows.reduce(function (w, r) {
      return Math.max(w, r.id.length);
    }, 0);
    return (
      title +
      ':\n' +
      rows
        .map(function (r) {
          return (r.id === currentId ? '> ' : '  ') + r.id.padEnd(width) + '  ' + r.label;
        })
        .join('\n') +
      '\n\n' +
      usage
    );
  }

  // Every character of the query appears in the name, in order but not
  // necessarily adjacent. Cheap, and right for a list of this size; if
  // the command set ever reaches the hundreds this wants a score.
  function fuzzy(name, query) {
    let i = 0;
    for (const c of name) {
      if (c === query[i]) i++;
      if (i === query.length) return true;
    }
    return i === query.length;
  }

  function create(opts) {
    const cfg = opts || {};
    const sidebar = cfg.sidebar || null;
    const registry = cfg.registry || (sidebar ? sidebar.registry : null);
    const activeTerminal =
      typeof cfg.activeTerminal === 'function'
        ? cfg.activeTerminal
        : function () {
            return null;
          };
    const openSession = typeof cfg.openSession === 'function' ? cfg.openSession : function () {};
    // The HUD's theme <select>, if this shell has one. /theme has to
    // move it or the two disagree about what the page is wearing.
    const themeSelect = cfg.themeSelect || null;
    // cfg.shell — which of SHELLS this page is, so /shell can mark the
    // current row and skip a navigation to where we already are. A
    // shell that does not say is simply never the current one, which is
    // harmless: the list still lists and the links still work.
    //
    // cfg.navigate exists because jsdom has no navigation and
    // window.location is unforgeable, so /shell would otherwise be the
    // one command no unit test can reach past its first line.
    const navigate =
      typeof cfg.navigate === 'function'
        ? cfg.navigate
        : function (href) {
            window.location.assign(href);
          };

    const isMac =
      typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
    const MOD = isMac ? 'Cmd' : 'Ctrl';

    // ── Overlay scaffolding ──────────────────────────────────────────

    const overlays = [];

    function overlay(id, modalClass) {
      const wrap = mk('div', 'modal-overlay');
      wrap.id = id;
      const box = mk('div', 'modal' + (modalClass ? ' ' + modalClass : ''));
      wrap.appendChild(box);
      // Clicking the scrim closes; clicking the modal does not. The
      // check is on the target rather than a stopPropagation inside,
      // because the modal's own children are added later by callers.
      wrap.addEventListener('click', function (e) {
        if (e.target === wrap) close(wrap);
      });
      document.body.appendChild(wrap);
      overlays.push(wrap);
      return box;
    }

    function open(wrap) {
      wrap.classList.add('open');
    }

    function close(wrap) {
      wrap.classList.remove('open');
      // The terminal is where typing goes when nothing is modal, and
      // leaving focus on a hidden input strands the keyboard.
      const t = activeTerminal();
      if (t) t.focusInput();
    }

    function anyOpen() {
      return (
        overlays.some(function (w) {
          return w.classList.contains('open');
        }) || batchPanel.classList.contains('open')
      );
    }

    function closeAll() {
      overlays.forEach(function (w) {
        w.classList.remove('open');
      });
      batchPanel.classList.remove('open');
    }

    // A fuzzy-filtered list of rows, shared by the palette and the
    // picker: same markup, same keyboard, different rows.
    function filterList(listEl, rows, query, onPick) {
      const q = (query || '').trim().toLowerCase().replace(/^\//, '');
      const matches = (
        q
          ? rows.filter(function (r) {
              return fuzzy(r.key.toLowerCase(), q);
            })
          : rows
      ).slice(0, 30);
      listEl.replaceChildren();
      matches.forEach(function (r) {
        const item = mk('div', 'palette-item');
        item.appendChild(mk('span', 'palette-cmd', r.label));
        item.appendChild(mk('span', 'palette-src', r.meta || ''));
        item.title = r.title || '';
        item.addEventListener('click', function () {
          onPick(r);
        });
        listEl.appendChild(item);
      });
      return matches;
    }

    function finderModal(id, placeholder, key) {
      const box = overlay(id, 'palette');
      const input = document.createElement('input');
      input.type = 'text';
      input.id = key + '-input';
      input.placeholder = placeholder;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', placeholder);
      const list = mk('div');
      list.id = key + '-list';
      box.append(input, list);
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        const first = list.querySelector('.palette-item');
        if (!first) return;
        e.preventDefault();
        first.click();
      });
      return { wrap: box.parentNode, box: box, input: input, list: list };
    }

    // ── Command palette ──────────────────────────────────────────────
    //
    // Its rows come out of the terminal, not out of this file: the
    // merged built-in + shell + agent-advertised table, already run
    // through the capability gate. Offering a name the prompt would
    // then refuse is exactly the failure #45 was about, and the only
    // way to be sure is to ask the thing that will answer.

    const palette = finderModal('palette-modal', 'Type to search commands…', 'palette');

    function paletteRows() {
      const t = activeTerminal();
      if (!t) return [];
      return t.commands.map(function (c) {
        return { key: c.name, label: '/' + c.name, meta: c.source, title: c.help || '' };
      });
    }

    function refreshPalette() {
      filterList(palette.list, paletteRows(), palette.input.value, function (r) {
        close(palette.wrap);
        const t = activeTerminal();
        // Prefilled rather than run: a command with arguments is the
        // normal case, and a palette that fires /tools bare has picked
        // the wrong one of the two meanings of "select".
        if (t) t.prefill(r.label + ' ');
      });
    }

    palette.input.addEventListener('input', refreshPalette);

    function openPalette() {
      if (!activeTerminal()) return;
      palette.input.value = '';
      refreshPalette();
      open(palette.wrap);
      setTimeout(function () {
        palette.input.focus();
      }, 0);
    }

    // ── Session picker ───────────────────────────────────────────────
    //
    // Every session on every attached daemon, in one keystroke. The
    // sidebar already lists them, but a sidebar is a thing you aim at;
    // this is the thing you type at, and with four daemons attached the
    // difference is the whole feature.
    //
    // "Switch" in a shell where each panel owns its own client means
    // open-or-focus, which is what the shell's openSession does — the
    // classic shell's selectSession() retargeted its one transcript,
    // and there is no one transcript here to retarget.

    const picker = finderModal('picker-modal', 'Type to search sessions…', 'picker');

    function pickerRows() {
      if (!registry) return [];
      const rows = [];
      registry.listDaemons().forEach(function (d) {
        (d.sessions || []).forEach(function (s) {
          rows.push({
            key: (s.title || '') + ' ' + s.id + ' ' + (d.alias || d.endpoint),
            label: s.title || s.id,
            meta: d.alias || d.endpoint,
            title: s.id + ' · ' + d.endpoint,
            daemon: d,
            session: s,
          });
        });
      });
      return rows;
    }

    function refreshPicker() {
      filterList(picker.list, pickerRows(), picker.input.value, function (r) {
        close(picker.wrap);
        openSession(r.daemon, r.session);
      });
    }

    picker.input.addEventListener('input', refreshPicker);

    function openPicker() {
      picker.input.value = '';
      refreshPicker();
      open(picker.wrap);
      setTimeout(function () {
        picker.input.focus();
      }, 0);
    }

    // ── Shortcuts overlay ────────────────────────────────────────────
    //
    // The shell's own bindings plus whatever the host shell passes in —
    // solo's tab strip and spatial's camera are not this module's to
    // know about, but an overlay that lists half the keyboard is worse
    // than no overlay.

    const shortcutsBox = overlay('shortcuts-modal');
    const shortcutsWrap = shortcutsBox.parentNode;
    shortcutsBox.appendChild(mk('h2', null, 'Keyboard shortcuts'));
    const shortcutsTable = mk('table');
    shortcutsTable.id = 'shortcuts-table';
    const shortcutsBody = mk('tbody');
    shortcutsTable.appendChild(shortcutsBody);
    shortcutsBox.appendChild(shortcutsTable);
    const shortcutsRow = mk('div', 'btn-row');
    const shortcutsClose = mk('button', 'btn-primary', 'Close');
    shortcutsClose.type = 'button';
    shortcutsClose.addEventListener('click', function () {
      close(shortcutsWrap);
    });
    shortcutsRow.appendChild(shortcutsClose);
    shortcutsBox.appendChild(shortcutsRow);

    function openShortcuts() {
      shortcutsBody.replaceChildren();
      BINDINGS.concat(cfg.shortcuts || []).forEach(function (s) {
        const tr = mk('tr');
        const keyCell = mk('td');
        keyCell.appendChild(mk('kbd', null, s.key));
        tr.append(keyCell, mk('td', null, s.description));
        shortcutsBody.appendChild(tr);
      });
      open(shortcutsWrap);
    }

    // ── Batch runner ─────────────────────────────────────────────────
    //
    // One prompt per line, run in order against the focused terminal,
    // with per-turn latency / TTFB / tokens / cost as each lands. The
    // measurements come from the terminal's own submit() — the same
    // numbers the turn footer shows — rather than from a second
    // measurement path, which is how app.js's version and its footers
    // could disagree.
    //
    // Stop halts before the next prompt; the in-flight turn is left to
    // finish. Interrupting mid-turn is /interrupt's job and entangling
    // the two would make "stop" mean two things.

    const batchPanel = mk('div');
    batchPanel.id = 'batch-panel';
    const batchHead = mk('div', 'batch-header');
    batchHead.appendChild(mk('h3', null, 'Batch runner'));
    const batchClose = mk('button', 'side-icon', '×');
    batchClose.type = 'button';
    batchClose.title = 'Close';
    batchHead.appendChild(batchClose);
    const batchInput = mk('textarea');
    batchInput.id = 'batch-input';
    batchInput.placeholder = 'One prompt per line…';
    const batchActions = mk('div', 'batch-actions');
    const batchRun = mk('button', null, 'Run batch');
    batchRun.type = 'button';
    const batchStop = mk('button', null, 'Stop');
    batchStop.type = 'button';
    batchStop.hidden = true;
    batchActions.append(batchRun, batchStop);
    const batchProgress = mk('div');
    batchProgress.id = 'batch-progress';
    batchProgress.hidden = true;
    const batchProgressText = mk('div');
    batchProgressText.id = 'batch-progress-text';
    const batchBarWrap = mk('div');
    batchBarWrap.id = 'batch-progress-bar';
    const batchBar = mk('span');
    batchBarWrap.appendChild(batchBar);
    batchProgress.append(batchProgressText, batchBarWrap);
    const batchResults = mk('div');
    batchResults.id = 'batch-results';
    batchPanel.append(batchHead, batchInput, batchActions, batchProgress, batchResults);
    document.body.appendChild(batchPanel);

    batchClose.addEventListener('click', function () {
      batchPanel.classList.remove('open');
    });

    let cancel = null;

    function toggleBatch(force) {
      const wanted = force === undefined ? !batchPanel.classList.contains('open') : !!force;
      batchPanel.classList.toggle('open', wanted);
      if (wanted) batchInput.focus();
      return wanted;
    }

    function ms(n) {
      return Math.round(n) + 'ms';
    }

    function renderBatch(entries) {
      batchResults.replaceChildren();
      if (entries.length === 0) return;
      const table = mk('table');
      const head = mk('tr');
      ['Prompt', 'Total', 'TTFB', 'In', 'Out', 'Cost', 'Status'].forEach(function (h) {
        head.appendChild(mk('th', null, h));
      });
      const thead = mk('thead');
      thead.appendChild(head);
      const tbody = mk('tbody');
      entries.forEach(function (e) {
        const tr = mk('tr');
        tr.appendChild(
          mk('td', null, e.prompt.length > 60 ? e.prompt.slice(0, 60) + '…' : e.prompt)
        );
        if (e.status === 'done') {
          const r = e.result;
          tr.appendChild(mk('td', null, ms(r.totalMs)));
          tr.appendChild(mk('td', null, ms(r.ttfbMs)));
          tr.appendChild(mk('td', null, String(r.tokens.in)));
          tr.appendChild(mk('td', null, String(r.tokens.out)));
          tr.appendChild(mk('td', null, '$' + (r.costUSD || 0).toFixed(4)));
        } else if (e.status === 'error') {
          const cell = mk('td', null, e.error || '');
          cell.colSpan = 5;
          cell.style.color = 'var(--red)';
          tr.appendChild(cell);
        } else {
          const cell = mk('td', null, '—');
          cell.colSpan = 5;
          tr.appendChild(cell);
        }
        tr.appendChild(mk('td', null, e.status));
        tbody.appendChild(tr);
      });
      table.append(thead, tbody);
      batchResults.appendChild(table);
    }

    async function runBatch() {
      const term = activeTerminal();
      if (!term) return;
      if (cancel) return;
      const prompts = batchInput.value
        .split('\n')
        .map(function (p) {
          return p.trim();
        })
        .filter(Boolean);
      if (prompts.length === 0) return;

      // Seeded as pending so the table shows the shape of the whole run
      // immediately, rather than growing a row at a time out of
      // nothing.
      const entries = prompts.map(function (p) {
        return { prompt: p, status: 'pending' };
      });
      const mine = { cancelled: false };
      cancel = mine;
      batchRun.disabled = true;
      batchStop.hidden = false;
      batchProgress.hidden = false;
      renderBatch(entries);

      for (let i = 0; i < entries.length; i++) {
        if (mine.cancelled) {
          for (let j = i; j < entries.length; j++) entries[j].status = 'cancelled';
          break;
        }
        entries[i].status = 'running';
        renderBatch(entries);
        const r = await term.submit(entries[i].prompt);
        if (!r) {
          entries[i] = {
            prompt: entries[i].prompt,
            status: 'error',
            error: 'the terminal took no turn — not connected, or one is already running',
          };
        } else if (r.ok) {
          entries[i] = { prompt: entries[i].prompt, status: 'done', result: r };
        } else {
          entries[i] = { prompt: entries[i].prompt, status: 'error', error: r.error };
        }
        batchProgressText.textContent = i + 1 + ' of ' + entries.length + ' done';
        batchBar.style.width = Math.round(((i + 1) / entries.length) * 100) + '%';
        renderBatch(entries);
      }

      renderBatch(entries);
      batchStop.hidden = true;
      batchRun.disabled = false;
      cancel = null;
    }

    batchRun.addEventListener('click', runBatch);
    batchStop.addEventListener('click', function () {
      if (cancel) cancel.cancelled = true;
    });

    // ── Slash commands ───────────────────────────────────────────────

    function cmdTheme(args, io) {
      const themes = window.MastTheme.THEMES;
      if (args.length === 0) {
        io.print(listRegistry('Themes', themes, window.MastTheme.current(), 'Usage: /theme <id>'));
        return;
      }
      const id = args[0].toLowerCase();
      if (
        !themes.some(function (t) {
          return t.id === id;
        })
      ) {
        io.print('Unknown theme "' + id + '". /theme with no arguments lists them.');
        return;
      }
      window.MastTheme.apply(id);
      // The HUD picker is the same setting by another route; leaving it
      // showing the old name makes the shell look like it disagrees
      // with itself.
      if (themeSelect) themeSelect.value = id;
      io.print('Theme: ' + id);
    }

    function cmdLayout(args, io) {
      if (args.length === 0) {
        io.print(listRegistry('Layouts', LAYOUTS, currentLayout(), 'Usage: /layout <id>'));
        return;
      }
      const id = args[0].toLowerCase();
      if (!knownLayout(id)) {
        io.print('Unknown layout "' + id + '". /layout with no arguments lists them.');
        return;
      }
      applyLayout(id);
      io.print('Layout: ' + id);
    }

    // /attach adds a daemon; it does not swap one. Every terminal
    // already open stays open on the backend it was opened against —
    // this shell holds a live connection per panel, so there is nothing
    // to tear down and no reason to.
    async function cmdAttach(args, io) {
      if (!registry) {
        io.print('This shell has no daemon registry.');
        return;
      }
      const url = args[0];
      if (!url) {
        io.print(
          'Usage: /attach <url> [<token>]\n' +
            'Adds a backend daemon. Everything already attached stays attached.\n\n' +
            'Attached:\n' +
            registry
              .listDaemons()
              .map(function (d) {
                return (
                  '  ' +
                  d.alias +
                  '  ' +
                  d.endpoint +
                  '  ' +
                  d.state +
                  ' · ' +
                  d.sessions.length +
                  ' session' +
                  (d.sessions.length === 1 ? '' : 's')
                );
              })
              .join('\n')
        );
        return;
      }
      // A path is legitimate here — behind a BFF the attach API lives
      // under --api-prefix on this same origin, and that deployment is
      // the one GET /config exists for. Anything else that is not an
      // absolute http(s) URL is a typo caught before the fetch.
      if (!/^https?:\/\//i.test(url) && url[0] !== '/') {
        io.print('/attach: expected an http(s):// URL or a same-origin path, got "' + url + '"');
        return;
      }
      // add() normalizes the URL and returns the existing record
      // untouched when there is one, so the count is what tells the two
      // apart — and it does it without this file needing to know how an
      // endpoint gets normalized.
      const before = registry.listDaemons().length;
      const d = registry.add(url, args[1] || '');
      const existing = registry.listDaemons().length === before;
      const fresh = await registry.refresh(d);
      if (fresh && fresh.state === 'error') {
        io.print('/attach: ' + d.endpoint + ' is attached but not answering: ' + fresh.lastError);
        return;
      }
      const n = fresh ? fresh.sessions.length : 0;
      io.print(
        (existing ? 'Already attached: ' : 'Attached ') +
          d.endpoint +
          ' — ' +
          n +
          ' session' +
          (n === 1 ? '' : 's') +
          '.'
      );
    }

    function cmdBatch(args, io) {
      io.print(toggleBatch() ? 'Batch runner open.' : 'Batch runner closed.');
    }

    // /shell — the same choice the HUD link makes, from the prompt.
    // Navigating away is the whole command: a shell is a document, and
    // the sessions come back because they are on the server, not in
    // this page. Which is also why the preference is written before the
    // navigation rather than after it — there is no after.
    function cmdShell(args, io) {
      const here = cfg.shell || '';
      if (args.length === 0) {
        io.print(
          listRegistry(
            'Shells',
            SHELLS,
            here,
            'Usage: /shell <id>\nStored preference: ' +
              preferredShell() +
              ' — this is where / lands you.'
          )
        );
        return;
      }
      const id = args[0].toLowerCase();
      const target = shellByID(id);
      if (!target) {
        io.print('Unknown shell "' + id + '". /shell with no arguments lists them.');
        return;
      }
      rememberShell(id);
      if (id === here) {
        io.print('Already in the ' + id + ' shell. / will land here from now on.');
        return;
      }
      io.print('Opening the ' + id + ' shell…');
      navigate(target.href);
    }

    function cmdShortcuts(args, io) {
      openShortcuts();
      io.print('Keyboard reference: ' + MOD + '+/ opens this any time.');
    }

    // Offline to a command, `true` here, means "does not need a
    // backend". All six of these act on the window, so none of them
    // do — /attach included, which is how you get a backend in the
    // first place and would be useless if it needed one.
    const commands = [
      {
        name: 'theme',
        usage: '/theme [id]',
        help: 'Colour scheme for every panel',
        offline: true,
        run: cmdTheme,
      },
      {
        name: 'layout',
        usage: '/layout [id]',
        help: 'Transcript arrangement: log or chat',
        offline: true,
        run: cmdLayout,
      },
      {
        name: 'attach',
        usage: '/attach [url] [token]',
        help: 'Add a backend daemon, keeping the ones already attached',
        offline: true,
        run: cmdAttach,
      },
      {
        name: 'batch',
        usage: '/batch',
        help: 'Run a list of prompts in order, timing each',
        offline: true,
        run: cmdBatch,
      },
      {
        name: 'shortcuts',
        usage: '/shortcuts',
        help: 'Keyboard reference for this shell',
        offline: true,
        run: cmdShortcuts,
      },
      {
        name: 'shell',
        usage: '/shell [id]',
        help: 'Switch shells, and remember which one / opens',
        offline: true,
        run: cmdShell,
      },
    ];

    // ── Keyboard ─────────────────────────────────────────────────────
    //
    // Capture phase, and the event is stopped only on the bindings that
    // actually fire. The shells install their own keydown handlers —
    // spatial parks the centred panel on Escape, solo closes a tab on
    // alt+W — and both were registered before this one. Capture is what
    // puts this first without either shell knowing modals exist.
    //
    // stopImmediatePropagation, not stopPropagation: spatial's handler
    // is on `document` too, and plain stopPropagation does not stop
    // other listeners on the same node — Escape would close the modal
    // and park the panel behind it in one keystroke.

    const BINDINGS = [
      {
        key: MOD + '+K',
        description: 'Find a session, across every attached daemon',
        test: function (e) {
          return mod(e) && e.key.toLowerCase() === 'k';
        },
        run: openPicker,
      },
      {
        key: MOD + '+P',
        description: 'Command palette',
        test: function (e) {
          return mod(e) && e.key.toLowerCase() === 'p';
        },
        run: openPalette,
      },
      {
        key: MOD + '+/',
        description: 'This list',
        test: function (e) {
          return mod(e) && e.key === '/';
        },
        run: openShortcuts,
      },
      {
        key: 'Esc',
        description: 'Close whatever is open',
        test: function (e) {
          return e.key === 'Escape' && anyOpen();
        },
        run: closeAll,
      },
    ];

    function mod(e) {
      return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    }

    function onKeydown(e) {
      // Holding a chord down should not reopen the palette sixty times
      // a second.
      if (e.repeat) return;
      for (const b of BINDINGS) {
        if (!b.test(e)) continue;
        e.preventDefault();
        e.stopImmediatePropagation();
        b.run();
        return;
      }
    }

    document.addEventListener('keydown', onKeydown, true);

    // The HUD's link to the other shell is a plain <a href> — it should
    // keep working with scripting off, and a click handler that
    // navigates is a worse anchor than an anchor. All this adds is the
    // memory: the link carries data-shell, and following it records
    // where you went.
    const switchLinks = Array.from(document.querySelectorAll('[data-shell]'));
    function onSwitchClick(e) {
      rememberShell(e.currentTarget.getAttribute('data-shell'));
    }
    switchLinks.forEach(function (a) {
      a.addEventListener('click', onSwitchClick);
    });

    // The stored layout is applied here rather than by each shell: it
    // is this module's setting, and a shell that forgot the call would
    // silently lose the operator's choice on reload.
    applyLayout(storedLayout());

    return {
      commands: commands,
      openPalette: openPalette,
      openPicker: openPicker,
      openShortcuts: openShortcuts,
      toggleBatch: toggleBatch,
      closeAll: closeAll,
      anyOpen: anyOpen,
      bindings: BINDINGS,
      destroy: function () {
        document.removeEventListener('keydown', onKeydown, true);
        switchLinks.forEach(function (a) {
          a.removeEventListener('click', onSwitchClick);
        });
        overlays.forEach(function (w) {
          w.remove();
        });
        batchPanel.remove();
      },
    };
  }

  return {
    create: create,
    LAYOUTS: LAYOUTS,
    applyLayout: applyLayout,
    currentLayout: currentLayout,
    SHELLS: SHELLS,
    rememberShell: rememberShell,
    preferredShell: preferredShell,
  };
})();
