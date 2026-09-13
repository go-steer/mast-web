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

// Unit tests for web/shell.js — the window-level half of the v0.4
// capability port (#60, PR 3b).
//
// The overlays are DOM and could be left to the smoke suite, but two
// things here are decisions rather than drawings and want a faster
// test: that the palette's rows come out of the terminal that will run
// them (the one-read rule, #45, one level up from terminal.js's own
// table), and that the batch runner reports what actually happened to
// each prompt rather than what it hoped would.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const load = (rel) => new Function('window', readFileSync(join(here, rel), 'utf8'))(globalThis);

// A stand-in for a MastTerminal: the four members shell.js touches.
function stubTerminal(commands) {
  return {
    commands: commands || [
      { name: 'help', usage: '/help', help: 'This list', source: 'builtin' },
      { name: 'tools', usage: '/tools', help: 'Tool catalog', source: 'builtin' },
      { name: 'compact', usage: '/compact', help: 'Advertised', source: 'agent' },
    ],
    prefilled: [],
    focused: 0,
    submitted: [],
    results: [],
    prefill(text) {
      this.prefilled.push(text);
    },
    focusInput() {
      this.focused++;
    },
    async submit(text) {
      this.submitted.push(text);
      const r = this.results.shift();
      return r === undefined ? { ok: true, totalMs: 1, ttfbMs: 1, tokens: { in: 0, out: 0 } } : r;
    },
  };
}

// Enough of state/daemons.js for /attach: add() is idempotent per
// endpoint and hands back the record either way, which is how the
// command tells "attached" from "already attached".
function fakeRegistry(daemons) {
  const rows = (daemons || []).slice();
  return {
    rows,
    listDaemons: () => rows,
    add(endpoint) {
      const found = rows.find((d) => d.endpoint === endpoint);
      if (found) return found;
      const rec = { endpoint, alias: endpoint, state: 'connecting', sessions: [] };
      rows.push(rec);
      return rec;
    },
    async refresh(d) {
      d.state = 'connected';
      return d;
    },
  };
}

describe('MastShell', () => {
  let term;
  let mounted;
  let navigated;

  function mount(over) {
    term = over && 'terminal' in over ? over.terminal : stubTerminal();
    const shell = globalThis.MastShell.create({
      activeTerminal: () => term,
      registry: fakeRegistry((over && over.daemons) || []),
      openSession: (over && over.openSession) || (() => {}),
      themeSelect: over && over.themeSelect,
      shortcuts: over && over.shortcuts,
      shell: over && over.shell,
      navigate: (over && over.navigate) || ((href) => navigated.push(href)),
    });
    mounted.push(shell);
    return shell;
  }

  // Runs a shell command the way terminal.js dispatches one, and
  // returns whatever it printed.
  async function run(shell, name, args) {
    const out = [];
    const cmd = shell.commands.find((c) => c.name === name);
    await cmd.run(args || [], { print: (t) => out.push(t), terminal: term });
    return out.join('\n');
  }

  const items = (listId) =>
    Array.from(document.querySelectorAll('#' + listId + ' .palette-item')).map(
      (el) => el.querySelector('.palette-cmd').textContent
    );

  const isOpen = (id) => document.getElementById(id).classList.contains('open');

  beforeEach(() => {
    document.body.replaceChildren();
    document.body.removeAttribute('data-layout');
    document.body.removeAttribute('data-theme');
    localStorage.clear();
    mounted = [];
    navigated = [];
    delete globalThis.MastShell;
    load('theme.js');
    load('shell.js');
  });

  // The keydown installer is on `document`, which replaceChildren()
  // does not touch — a shell left mounted would go on claiming Escape
  // for the next test's chords.
  afterEach(() => {
    mounted.forEach((s) => s.destroy());
  });

  describe('the commands it contributes', () => {
    it('are all offline — none of them needs a backend', () => {
      const shell = mount();
      expect(shell.commands.map((c) => c.name).sort()).toEqual([
        'attach',
        'batch',
        'layout',
        'shell',
        'shortcuts',
        'theme',
      ]);
      // /attach included: it is how you get a backend, and would be
      // useless if it needed one.
      expect(shell.commands.every((c) => c.offline)).toBe(true);
    });

    it('/theme lists with the current one marked, and applies by id', async () => {
      const select = document.createElement('select');
      ['default', 'mono'].forEach((id) => {
        const o = document.createElement('option');
        o.value = id;
        select.appendChild(o);
      });
      const shell = mount({ themeSelect: select });

      expect(await run(shell, 'theme')).toContain('> default');
      expect(await run(shell, 'theme', ['mono'])).toContain('Theme: mono');
      expect(document.body.getAttribute('data-theme')).toBe('mono');
      // The HUD picker is the same setting by another route; leaving it
      // on the old name makes the shell look like it disagrees with
      // itself.
      expect(select.value).toBe('mono');
    });

    it('/theme refuses a name it does not have', async () => {
      const shell = mount();
      expect(await run(shell, 'theme', ['neon'])).toContain('Unknown theme "neon"');
      expect(document.body.hasAttribute('data-theme')).toBe(false);
    });

    it('/layout sets the body attribute and persists the choice', async () => {
      const shell = mount();
      expect(await run(shell, 'layout', ['chat'])).toContain('Layout: chat');
      expect(document.body.getAttribute('data-layout')).toBe('chat');
      expect(localStorage.getItem('mast-web:layout')).toBe('chat');

      // log is the default, and defaults are the absence of the
      // attribute — same shape theme.js uses.
      await run(shell, 'layout', ['log']);
      expect(document.body.hasAttribute('data-layout')).toBe(false);
      expect(localStorage.getItem('mast-web:layout')).toBe('log');
    });

    // Under the key app.js already used, so the choice survives the
    // walk over from the classic shell — and survives its deletion.
    it('restores the stored layout when it mounts', () => {
      localStorage.setItem('mast-web:layout', 'chat');
      mount();
      expect(document.body.getAttribute('data-layout')).toBe('chat');
    });

    it('/attach adds a daemon and reports what it found', async () => {
      const shell = mount();
      const out = await run(shell, 'attach', ['https://b']);
      expect(out).toContain('Attached https://b');
      expect(out).toContain('0 sessions');
    });

    it('/attach with no argument lists what is already attached', async () => {
      const shell = mount({
        daemons: [
          { alias: 'a', endpoint: 'https://a', state: 'connected', sessions: [{ id: 's1' }] },
        ],
      });
      const out = await run(shell, 'attach');
      expect(out).toContain('https://a');
      expect(out).toContain('1 session');
    });

    it('/attach rejects something that is not an address', async () => {
      const shell = mount();
      expect(await run(shell, 'attach', ['localhost:8080'])).toContain('expected an http(s)://');
    });

    it('/batch and /shortcuts open their panels', async () => {
      const shell = mount();
      expect(await run(shell, 'batch')).toContain('Batch runner open.');
      expect(isOpen('batch-panel')).toBe(true);
      expect(await run(shell, 'batch')).toContain('Batch runner closed.');

      await run(shell, 'shortcuts');
      expect(isOpen('shortcuts-modal')).toBe(true);
    });
  });

  // `/` reads the same key this writes (web/shell-select.js), so these
  // two halves are the whole of the v0.4 §1 precedence table that lives
  // in a shell: the default and the deep link belong to that file.
  describe('choosing a shell', () => {
    it('/shell lists both, marking the one you are in', async () => {
      const shell = mount({ shell: 'solo' });
      const out = await run(shell, 'shell');
      expect(out).toContain('> solo');
      expect(out).toContain('  spatial');
      expect(out).toContain('Stored preference: solo');
      expect(navigated).toEqual([]);
    });

    it('/shell <id> records the preference and goes there', async () => {
      const shell = mount({ shell: 'solo' });
      expect(await run(shell, 'shell', ['spatial'])).toContain('Opening the spatial shell');
      expect(localStorage.getItem('mast-web:shell')).toBe('spatial');
      expect(navigated).toEqual(['spatial.html']);
    });

    it('/shell for the shell you are in records it without reloading', async () => {
      const shell = mount({ shell: 'solo' });
      expect(await run(shell, 'shell', ['solo'])).toContain('Already in the solo shell');
      expect(localStorage.getItem('mast-web:shell')).toBe('solo');
      // Re-entering the page you are on would throw away every open
      // tab to arrive exactly where you already are.
      expect(navigated).toEqual([]);
    });

    it('/shell refuses a name that is not a shell', async () => {
      const shell = mount({ shell: 'solo' });
      expect(await run(shell, 'shell', ['chat'])).toContain('Unknown shell "chat"');
      expect(localStorage.getItem('mast-web:shell')).toBe(null);
      expect(navigated).toEqual([]);
    });

    it('following the HUD link is what sets the preference', () => {
      const link = document.createElement('a');
      link.setAttribute('data-shell', 'spatial');
      link.href = 'spatial.html';
      document.body.appendChild(link);

      const shell = mount({ shell: 'solo' });
      link.click();
      expect(localStorage.getItem('mast-web:shell')).toBe('spatial');

      // And the listener goes with the shell — a torn-down shell that
      // still rewrote the preference on click would be a ghost vote.
      localStorage.clear();
      shell.destroy();
      mounted.length = 0;
      link.click();
      expect(localStorage.getItem('mast-web:shell')).toBe(null);
    });
  });

  // The whole reason the palette reads the terminal rather than keeping
  // its own list: a palette that offers a name the prompt would refuse
  // is the second read #45 exists to remove.
  describe('the command palette', () => {
    it('lists exactly what the focused terminal will dispatch', () => {
      const shell = mount();
      shell.openPalette();
      expect(items('palette-list')).toEqual(['/help', '/tools', '/compact']);
    });

    it('fuzzy-matches by subsequence', () => {
      const shell = mount();
      shell.openPalette();
      document.getElementById('palette-input').value = 'tls';
      document.getElementById('palette-input').dispatchEvent(new globalThis.Event('input'));
      expect(items('palette-list')).toEqual(['/tools']);
    });

    // Picking /tools should leave you able to type " builtin" after it,
    // not commit you to the bare command.
    it('prefills rather than runs', () => {
      const shell = mount();
      shell.openPalette();
      document.querySelector('#palette-list .palette-item').click();
      expect(term.prefilled).toEqual(['/help ']);
      expect(term.submitted).toEqual([]);
      expect(isOpen('palette-modal')).toBe(false);
    });

    it('stays shut when there is no terminal to run anything', () => {
      const shell = mount({ terminal: null });
      shell.openPalette();
      expect(isOpen('palette-modal')).toBe(false);
    });
  });

  describe('the session picker', () => {
    const daemons = [
      {
        alias: 'a',
        endpoint: 'https://a',
        sessions: [{ id: 's1', title: 'ops triage' }, { id: 's2' }],
      },
      { alias: 'b', endpoint: 'https://b', sessions: [{ id: 's3' }] },
    ];

    it('lists every session on every attached daemon', () => {
      const shell = mount({ daemons });
      shell.openPicker();
      expect(items('picker-list')).toEqual(['ops triage', 's2', 's3']);
    });

    // "Switch" in a shell where each panel owns its own client is
    // open-or-focus, not retargeting one transcript at another session
    // — which is why there is no selectSession() call anywhere here.
    it('hands the pick to the shell rather than moving a terminal', () => {
      const opened = [];
      const shell = mount({ daemons, openSession: (d, s) => opened.push([d.alias, s.id]) });
      shell.openPicker();
      document.querySelector('#picker-list .palette-item').click();
      expect(opened).toEqual([['a', 's1']]);
      expect(isOpen('picker-modal')).toBe(false);
    });

    it('matches on title, id and daemon alike', () => {
      const shell = mount({ daemons });
      shell.openPicker();
      const input = document.getElementById('picker-input');
      input.value = 'triage';
      input.dispatchEvent(new globalThis.Event('input'));
      expect(items('picker-list')).toEqual(['ops triage']);
      input.value = 'b';
      input.dispatchEvent(new globalThis.Event('input'));
      expect(items('picker-list')).toEqual(['s3']);
    });
  });

  describe('the shortcuts overlay', () => {
    it('lists its own bindings alongside the host shell’s', () => {
      const shell = mount({
        shortcuts: [{ key: 'Alt+W', description: 'Close the tab in front' }],
      });
      shell.openShortcuts();
      const text = document.getElementById('shortcuts-table').textContent;
      expect(text).toContain('Command palette');
      // A list that covers half the keyboard is worse than no list.
      expect(text).toContain('Alt+W');
      expect(text).toContain('Close the tab in front');
    });
  });

  describe('the keyboard', () => {
    const press = (key, over) =>
      document.dispatchEvent(
        new globalThis.KeyboardEvent('keydown', {
          key: key,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
          ...over,
        })
      );

    it('opens each overlay from its chord', () => {
      mount();
      press('p');
      expect(isOpen('palette-modal')).toBe(true);
      press('k');
      expect(isOpen('picker-modal')).toBe(true);
      press('/');
      expect(isOpen('shortcuts-modal')).toBe(true);
    });

    // spatial.js parks the centred panel on Escape and registered its
    // handler first, so this one runs in the capture phase — and stops
    // the event only when it had something to close.
    it('takes Escape only when something is open', () => {
      const shell = mount();
      const seen = [];
      document.addEventListener('keydown', (e) => seen.push(e.type));

      press('Escape', { ctrlKey: false });
      expect(seen).toHaveLength(1);

      shell.openPalette();
      press('Escape', { ctrlKey: false });
      expect(shell.anyOpen()).toBe(false);
      expect(seen).toHaveLength(1);
    });

    it('ignores a held-down chord', () => {
      const shell = mount();
      press('p', { repeat: true });
      expect(shell.anyOpen()).toBe(false);
    });

    it('stops listening once destroyed', () => {
      const shell = mount();
      shell.destroy();
      press('p');
      expect(document.getElementById('palette-modal')).toBeNull();
    });
  });

  describe('the batch runner', () => {
    const rowsOf = () =>
      Array.from(document.querySelectorAll('#batch-results tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => td.textContent)
      );

    async function runBatch(shell, text) {
      shell.toggleBatch(true);
      document.getElementById('batch-input').value = text;
      document.querySelector('.batch-actions button').click();
      await vi.waitFor(() =>
        expect(document.getElementById('batch-progress-text').textContent).toContain('done')
      );
    }

    it('runs the prompts in order and tabulates each turn', async () => {
      const shell = mount();
      term.results = [
        { ok: true, totalMs: 1200, ttfbMs: 300, tokens: { in: 30, out: 90 }, costUSD: 0.0042 },
        { ok: true, totalMs: 800, ttfbMs: 120, tokens: { in: 10, out: 20 }, costUSD: 0.001 },
      ];
      await runBatch(shell, 'first\nsecond\n\n  ');

      // Blank lines are not prompts.
      expect(term.submitted).toEqual(['first', 'second']);
      const rows = rowsOf();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(['first', '1200ms', '300ms', '30', '90', '$0.0042', 'done']);
      expect(rows[1][1]).toBe('800ms');
      expect(document.getElementById('batch-progress-text').textContent).toBe('2 of 2 done');
    });

    // A queue that reports a failed prompt as done is worse than one
    // that stops: the operator reads the table, not the transcript.
    it('records a failed turn as failed and keeps going', async () => {
      const shell = mount();
      term.results = [
        { ok: false, error: 'socket died' },
        { ok: true, totalMs: 10, ttfbMs: 5, tokens: { in: 1, out: 1 }, costUSD: 0 },
      ];
      await runBatch(shell, 'bad\ngood');
      const rows = rowsOf();
      expect(rows[0]).toEqual(['bad', 'socket died', 'error']);
      expect(rows[1].at(-1)).toBe('done');
    });

    it('explains a turn that never started', async () => {
      const shell = mount();
      term.results = [null];
      await runBatch(shell, 'only');
      expect(rowsOf()[0][1]).toContain('not connected');
    });

    it('does nothing without a terminal or without prompts', async () => {
      const shell = mount();
      shell.toggleBatch(true);
      document.getElementById('batch-input').value = '   \n  ';
      document.querySelector('.batch-actions button').click();
      await Promise.resolve();
      expect(term.submitted).toEqual([]);
      expect(rowsOf()).toEqual([]);
    });
  });
});
