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

// Unit tests for web/status-bar.js (PR 5a, #62).
//
// The smoke suite can see the bar and reads the slots it cares about.
// What it cannot cheaply drive is the arithmetic and the subscription
// bookkeeping: that the cost is a *sum* across the window and not the
// front terminal's own figure, that the bar repaints when a terminal it
// does not own changes, and that it lets go of a terminal that has been
// closed. A leaked subscription is invisible until the closed session's
// numbers start moving the bar again.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const load = (rel) => new Function('window', readFileSync(join(here, rel), 'utf8'))(globalThis);

// A stand-in for MastTerminal's seam: a state snapshot and a
// subscribe() that hands back an unsubscribe. That pair is the whole
// contract the bar depends on (PR 1, #58).
function makeTerminal(state) {
  const subs = new Set();
  return {
    state: Object.assign(
      {
        connState: 'connected',
        running: false,
        paused: false,
        costUSD: 0,
        turns: 0,
        model: '',
        label: '',
      },
      state
    ),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    // Move a field the way a real store would, and notify.
    poke(patch) {
      Object.assign(this.state, patch);
      subs.forEach((fn) => fn(this));
    },
    get subscriberCount() {
      return subs.size;
    },
  };
}

describe('MastStatusBar', () => {
  let el;
  let open;
  let front;

  // clock:false throughout — a ticking <span> is the one slot with
  // nothing to assert and a timer that would outlive the test.
  function mount(opts) {
    el = document.createElement('footer');
    document.body.appendChild(el);
    return globalThis.MastStatusBar.create(
      Object.assign(
        {
          el,
          clock: false,
          terminals: () => open,
          activeTerminal: () => front,
          label: (t) => t.state.label,
        },
        opts
      )
    );
  }

  const slot = (id) => el.querySelector('#' + id);

  beforeEach(() => {
    document.body.innerHTML = '';
    open = [];
    front = null;
    load('./status-bar.js');
  });

  it('reports the fleet, and how much of it is mid-turn', () => {
    const a = makeTerminal({ label: 'ops' });
    const b = makeTerminal({ label: 'docs', running: true });
    open = [a, b];
    const bar = mount();

    expect(slot('status-fleet').textContent).toBe('2 terminals · 1 running');

    b.poke({ running: false });
    expect(slot('status-fleet').textContent).toBe('2 terminals');

    open = [a];
    bar.sync();
    expect(slot('status-fleet').textContent).toBe('1 terminal');
  });

  // #70. The banner explaining a hold is in the panel that holds it,
  // which is also the one place you can't see from anywhere else: a
  // session parked behind an unclicked tab waits forever in silence.
  it('counts held sessions, which are not the same set as running ones', () => {
    const a = makeTerminal({ label: 'ops' });
    // Parked mid-turn — upstream's one `state` field can't say this and
    // neither could a bar that treated the two as exclusive.
    const b = makeTerminal({ label: 'docs', running: true, paused: true });
    open = [a, b];
    mount();

    expect(slot('status-fleet').textContent).toBe('2 terminals · 1 running · 1 held');

    b.poke({ paused: false });
    expect(slot('status-fleet').textContent).toBe('2 terminals · 1 running');
  });

  it('sums the cost across the window rather than reading one session', () => {
    open = [
      makeTerminal({ costUSD: 0.0123 }),
      makeTerminal({ costUSD: 0.2 }),
      makeTerminal({ costUSD: 1 }),
    ];
    mount();

    expect(slot('status-cost').textContent).toBe('$1.2123');
    expect(slot('status-cost').hidden).toBe(false);
  });

  it('hides the cost until something has been spent', () => {
    open = [makeTerminal({ costUSD: 0 })];
    mount();
    expect(slot('status-cost').hidden).toBe(true);

    open[0].poke({ costUSD: 0.00004 });
    // Four decimals, because a turn is routinely worth less than a
    // cent and $0.00 all afternoon is a rounding, not a cost.
    expect(slot('status-cost').hidden).toBe(false);
    expect(slot('status-cost').textContent).toBe('$0.0000');

    open[0].poke({ costUSD: 0.00006 });
    expect(slot('status-cost').textContent).toBe('$0.0001');
  });

  it('names the terminal in front and colours its connection', () => {
    const a = makeTerminal({ label: 'ops', model: 'claude-haiku-4-5-20251001', turns: 3 });
    open = [a];
    front = a;
    const bar = mount();

    // The date suffix goes; a status bar has one line and the date is
    // never the part you are reading it for.
    expect(slot('status-focus').textContent).toContain('ops · claude-haiku-4-5 · T3');
    expect(el.querySelector('.status-conn').dataset.state).toBe('connected');

    a.poke({ connState: 'terminal' });
    expect(el.querySelector('.status-conn').dataset.state).toBe('terminal');

    front = null;
    bar.render();
    expect(slot('status-focus').textContent).toContain('nothing in front');

    open = [];
    bar.sync();
    expect(slot('status-focus').textContent).toContain('no session');
  });

  it('repaints from a terminal it does not own, without being polled', () => {
    const a = makeTerminal({ label: 'ops' });
    open = [a];
    front = a;
    mount();

    expect(slot('status-fleet').textContent).toBe('1 terminal');
    a.poke({ running: true, costUSD: 0.5 });
    expect(slot('status-fleet').textContent).toBe('1 terminal · 1 running');
    expect(slot('status-cost').textContent).toBe('$0.5000');
  });

  it('lets go of a closed terminal', () => {
    const a = makeTerminal({ label: 'ops' });
    const b = makeTerminal({ label: 'docs' });
    open = [a, b];
    const bar = mount();
    expect(a.subscriberCount).toBe(1);
    expect(b.subscriberCount).toBe(1);

    open = [a];
    bar.sync();
    // Not merely "b no longer counted": a live subscription on a closed
    // session would keep repainting the bar from a terminal that is
    // gone, and nothing on screen would say so.
    expect(b.subscriberCount).toBe(0);
    expect(a.subscriberCount).toBe(1);

    bar.destroy();
    expect(a.subscriberCount).toBe(0);
  });

  it('counts the agents, and says how many are down', () => {
    const subs = new Set();
    const registry = {
      list: [],
      listDaemons() {
        return this.list;
      },
      subscribe(fn) {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      emit() {
        subs.forEach((fn) => fn());
      },
    };
    mount({ registry });

    // Nothing attached is not a state worth a slot; the bar starts on
    // solo.html with an empty registry every time.
    expect(slot('status-agents').hidden).toBe(true);

    registry.list = [
      { endpoint: 'http://a', state: 'connected' },
      { endpoint: 'http://b', state: 'error' },
    ];
    registry.emit();
    expect(slot('status-agents').hidden).toBe(false);
    // Counted, not just coloured: "1 down" out of two is a different
    // fact from "everything is down".
    expect(slot('status-agents').textContent).toBe('2 agents · 1 down');
    expect(slot('status-agents').title).toBe('http://a — connected\nhttp://b — error');
  });
});
