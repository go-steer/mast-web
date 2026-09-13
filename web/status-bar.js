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

// MastStatusBar — the bar along the bottom of the window, for both
// shells (#62, v0.4 plan §4a).
//
// Until now this was seven hardcoded keyboard hints and a clock, which
// is not a status bar; the classic shell's was worse-looking and told
// you more. The hints were also a second copy — both shells already
// list their keys in the sidebar hint, and the shortcuts overlay lists
// all of them — so nothing was lost by dropping them for state.
//
// What it says is deliberately *not* what a terminal's own status line
// says. Every panel already carries its connection dot, model, turn
// count, cost and elapsed timer at the foot of its own transcript
// (terminal.js). Repeating one of those up here would be a second read
// of the same number for the price of a whole bar. So this answers the
// questions the window has and a panel cannot:
//
//   how many agents am I attached to, and are they all up
//   how many terminals are open, and how many are mid-turn
//   what have all of them cost me so far
//   which one is in front, and is it connected
//
// The sum is the one that matters: a room of six sessions has six cost
// figures and no total, which is exactly the shape of a bill nobody
// notices. `/usage` answers it on demand for one session; this answers
// it passively for the window.
//
// No polling. Every terminal exposes its stores and a subscribe() —
// "a status bar can subscribe to a terminal it does not own" is the
// comment PR 1 (#58) left on the seam, and this is the thing it was
// left for. The shell only has to say when the *set* of terminals
// changed, because a terminal this bar has never seen cannot tell it
// about itself.
//
// Builds its own spans rather than reaching for ids in the markup, for
// the reason shell.js's overlays do: a shell that forgets a <span>
// should not be a shell with half a status bar.
//
// Requires: state/daemons.js (the registry), terminal.js (the
// terminals), and #app-status / .status-* styles from chrome.css.
//
//   const status = MastStatusBar.create({ el, registry, terminals, activeTerminal });
//   status.sync(); // a tab opened or closed
window.MastStatusBar = (function () {
  'use strict';

  function mk(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  // Four decimal places because agent turns are routinely worth less
  // than a cent, and a bar that reads $0.00 all afternoon and then
  // $0.01 is not reporting a cost, it is reporting a rounding.
  function money(usd) {
    return '$' + (Math.round(usd * 10000) / 10000).toFixed(4);
  }

  // The model id with its vendor prefix and date suffix taken off:
  // 'claude-opus-5' stays, 'claude-haiku-4-5-20251001' loses the date.
  // A status bar has one line and the date is never the part you are
  // reading it for.
  function shortModel(model) {
    return String(model || '').replace(/-\d{8}$/, '');
  }

  // opts:
  //   el             — the <footer> this fills; emptied on create
  //   registry       — a state/daemons instance, for the agent count
  //   terminals      — () → the open MastTerminal instances
  //   activeTerminal — () → the one in front, or null
  //   label          — (terminal, index) → its short name; defaults to
  //                    the session label the terminal already carries
  //   clock          — false to leave the time slot out (tests)
  function create(opts) {
    const cfg = opts || {};
    const el = cfg.el;
    if (!el) throw new Error('MastStatusBar.create: el is required');
    const registry = cfg.registry || null;
    const terminals =
      typeof cfg.terminals === 'function'
        ? cfg.terminals
        : function () {
            return [];
          };
    const activeTerminal =
      typeof cfg.activeTerminal === 'function'
        ? cfg.activeTerminal
        : function () {
            return null;
          };
    const label =
      typeof cfg.label === 'function'
        ? cfg.label
        : function (t) {
            return t.state.label || t.state.sessionId || '—';
          };

    // ── The slots ────────────────────────────────────────────────────

    el.textContent = '';

    const agents = mk('span', 'status-item', '');
    agents.id = 'status-agents';
    const agentsSep = mk('span', 'hud-sep', '|');

    const fleet = mk('span', 'status-item', '');
    fleet.id = 'status-fleet';
    const fleetSep = mk('span', 'hud-sep', '|');

    const cost = mk('span', 'status-item', '');
    cost.id = 'status-cost';
    cost.title = 'Total cost of every session open in this window';
    const costSep = mk('span', 'hud-sep', '|');

    // Kept as #status-focus: it is the slot both shells have always
    // written the front terminal into, and smoke reads it by that name.
    const focus = mk('span', 'status-item', '');
    focus.id = 'status-focus';
    const focusDot = mk('span', 'status-conn', '⬤');
    const focusText = mk('span', 'status-focus-text', 'no session');
    focus.append(focusDot, focusText);

    el.append(agents, agentsSep, fleet, fleetSep, cost, costSep, focus, mk('span', 'hud-spacer'));

    let clockEl = null;
    let clockTimer = 0;
    if (cfg.clock !== false) {
      clockEl = mk('span', 'status-item', '--:--:--');
      clockEl.id = 'status-clock';
      el.appendChild(clockEl);
    }

    // ── Painting ─────────────────────────────────────────────────────

    function paintAgents() {
      if (!registry) {
        agents.hidden = true;
        agentsSep.hidden = true;
        return;
      }
      const list = registry.listDaemons();
      const n = list.length;
      agents.hidden = n === 0;
      agentsSep.hidden = n === 0;
      if (!n) return;

      const down = list.filter(function (d) {
        return d.state === 'error';
      }).length;
      agents.textContent = n + (n === 1 ? ' agent' : ' agents');
      // Counted, not just coloured: "1 down" out of six is a different
      // fact from "everything is down", and a red dot says neither.
      if (down) {
        agents.appendChild(mk('span', 'status-bad', ' · ' + down + ' down'));
      }
      agents.title = list
        .map(function (d) {
          return d.endpoint + ' — ' + (d.state || 'disconnected');
        })
        .join('\n');
    }

    function paintFleet(open) {
      const n = open.length;
      fleet.textContent = n + (n === 1 ? ' terminal' : ' terminals');
      const running = open.filter(function (t) {
        return t.state.running;
      }).length;
      if (running) {
        fleet.appendChild(mk('span', 'status-live', ' · ' + running + ' running'));
      }
    }

    function paintCost(open) {
      const total = open.reduce(function (sum, t) {
        return sum + (t.state.costUSD || 0);
      }, 0);
      // Hidden rather than $0.0000 until something has actually been
      // spent: a zero that is always there is furniture, and furniture
      // is what this bar was before.
      cost.hidden = total <= 0;
      costSep.hidden = total <= 0;
      if (total > 0) cost.textContent = money(total);
    }

    function paintFocus(open) {
      const t = activeTerminal();
      if (!t) {
        focusDot.dataset.state = 'none';
        focusText.textContent = open.length ? 'nothing in front' : 'no session';
        focus.title = '';
        return;
      }
      const s = t.state;
      focusDot.dataset.state = s.connState || 'disconnected';
      const bits = [label(t, open.indexOf(t))];
      if (s.model) bits.push(shortModel(s.model));
      if (s.turns) bits.push('T' + s.turns);
      focusText.textContent = bits.join(' · ');
      focus.title = (s.endpoint || 'unknown endpoint') + ' — ' + (s.connState || 'disconnected');
    }

    function render() {
      const open = terminals();
      paintAgents();
      paintFleet(open);
      paintCost(open);
      paintFocus(open);
    }

    // ── Subscriptions ────────────────────────────────────────────────
    //
    // One per terminal, torn down and rebuilt on sync(). Rebuilding the
    // whole set is cheaper to get right than diffing it, and sync() is
    // called when a tab opens or closes — not on every frame.

    let termSubs = [];

    function resubscribe() {
      termSubs.forEach(function (off) {
        off();
      });
      termSubs = terminals()
        .map(function (t) {
          return typeof t.subscribe === 'function' ? t.subscribe(render) : null;
        })
        .filter(Boolean);
    }

    function sync() {
      resubscribe();
      render();
    }

    const offRegistry = registry ? registry.subscribe(render) : function () {};

    function tick() {
      if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('en-GB');
    }

    if (clockEl) {
      tick();
      clockTimer = window.setInterval(tick, 1000);
    }

    function destroy() {
      termSubs.forEach(function (off) {
        off();
      });
      termSubs = [];
      offRegistry();
      if (clockTimer) window.clearInterval(clockTimer);
    }

    sync();

    return {
      el: el,
      render: render,
      sync: sync,
      destroy: destroy,
    };
  }

  return { create: create };
})();
