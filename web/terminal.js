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

// MastTerminal — a self-contained, multi-instantiable mast terminal.
//
// The classic shell — index.html and its app.js, deleted in #61 — was a
// singleton: one AttachClient, one #output-area, one prompt, one status
// bar, all reached through module-scope constants. That's the right
// shape for a single-session SPA and the wrong shape for a workspace
// where four sessions are on screen at once.
//
// This is the same terminal with the singleton assumption removed.
// Every renderer that resolved against a module-scope `outputArea`
// resolves here against a per-instance element, and every piece of turn
// state lives with the instance instead of at module scope.
//
// Where that state lives, as of v0.4: session identity and per-session
// totals go in a state/session.js instance, connection and turn state
// in a state/connection.js one. Both used to be singletons and both
// are factories now, so a terminal holds a private pair rather than a
// hand-rolled `st` literal. What stays in the closure is only what
// nothing outside the transcript could use — DOM handles, half-drawn
// rows, the pending tool-call map.
//
// The payoff is api.subscribe(): a status bar, a tab strip or a radar
// blip can watch a terminal it doesn't own, instead of the shell
// polling term.state on a timer.
//
// What's here today: streaming markdown, tool-call rows with
// click-to-expand results, turn footers, the thinking indicator,
// interrupt, inline permission prompts, server-dispatched slash
// commands, grounded-source strips, observer-mode rendering of
// externally-driven turns, the hold — banner, controls, and steer
// (v1.5.0 §2.8) — and the client-side built-in slash commands: /help,
// /clear, /export, /tools, /mcp, /subagents, /perms, /specialists,
// /sessions, /guardrails, /pause, /continue, /abandon, /share, /model,
// /usage, /whoami — each gated on what the backend says it can serve.
//
// The commands that act on the window rather than on a session —
// /theme, /layout, /attach, /batch, /shortcuts — are not here, and are
// not missing either: a shell passes them in as `commands` and they
// join the same table, so /help lists them and the gate covers them
// without this file knowing what a theme is. web/shell.js is where
// both surviving shells get theirs.
//
// Genuinely not this file's job, because they belong to the shell
// around the terminals rather than to any one of them: the sidebar
// (including session delete) and the shortcuts / palette / picker
// modals. shell.js and spatial.js own those, the same way app.js did
// for the classic shell.
//
// With PR 3b that closes the parity list app.js had over a panel
// terminal. The target was never "most of it": a terminal in a panel
// should not be a lesser terminal than one in a tab, and where a
// feature needed a different presentation to fit the panel, that was a
// design problem to solve rather than a reason to drop it.
//
// Requires (load order): marked + marked-highlight + highlight.js from
// web/vendor/ — the CSP on spatial.html has no CDN in script-src — then
// attach-core/{errors,protocol,replay,client}.js.
//
//   const term = MastTerminal.create({ endpoint: '/', sessionId: 'abc' });
//   panelBody.appendChild(term.el);
//   await term.connect();

window.MastTerminal = (function () {
  'use strict';

  // ─── Shared helpers (stateless — safe across instances) ────────────

  let markdownReady = false;

  function configureMarkdown() {
    if (markdownReady) return;
    if (typeof marked === 'undefined') return; // CDN not loaded yet
    if (typeof markedHighlight !== 'undefined' && typeof hljs !== 'undefined') {
      marked.use(
        markedHighlight.markedHighlight({
          langPrefix: 'hljs language-',
          highlight(code, lang) {
            const language = hljs.getLanguage(lang) ? lang : 'plaintext';
            return hljs.highlight(code, { language, ignoreIllegals: true }).value;
          },
        })
      );
    }
    marked.setOptions({ gfm: true, breaks: true });
    markdownReady = true;
  }

  function renderMarkdown(text) {
    configureMarkdown();
    if (typeof marked !== 'undefined') {
      try {
        return marked.parse(text);
      } catch {
        // fall through to escaped-text fallback
      }
    }
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(s)));
    return div.innerHTML;
  }

  function clockStamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function nowStamp() {
    return clockStamp(new Date());
  }

  // A replayed row is drawn now but happened then, so it wears the
  // wire's clock. Null for a frame the server left unstamped — the
  // caller falls back to the wall clock rather than showing nothing.
  function wireStamp(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    return Number.isNaN(Number(d)) ? null : clockStamp(d);
  }

  function describeError(e, prefix) {
    const Drain = window.AttachClient && window.AttachClient.BackendDrainingError;
    if (Drain && e instanceof Drain) {
      return e.retryAfterSeconds
        ? `Backend is restarting — retry in ~${e.retryAfterSeconds}s.`
        : 'Backend is restarting — retry shortly.';
    }
    return (prefix || 'Error: ') + (e && e.message ? e.message : e);
  }

  // Plain-text rendering of a GET /whoami answer, for /whoami and for
  // the shells' identity slot.
  //
  // `source` is suppressed when it's "bearer" — that's the ordinary
  // case and printing it trains the operator to skim past the line
  // where it *isn't*. proxy_by and admin are never suppressed: one
  // says someone else signed for this caller, the other says the
  // session outranks what its operator would assume.
  function describeWhoami(who) {
    if (!who || !who.identity) return 'Backend reported no identity for this caller.';
    const notes = [];
    if (who.source && who.source !== 'bearer') notes.push('via ' + who.source);
    if (who.proxy_by) notes.push('on behalf of ' + who.proxy_by);
    if (who.admin) notes.push('admin');
    return who.identity + (notes.length ? ' (' + notes.join(', ') + ')' : '');
  }

  // Gemini grounding evidence. core-agent projects a turn's grounding
  // metadata into synthetic events — one per search query the model
  // issued, one per web source it grounded on — each carrying a single
  // plain text part and this author (core-agent
  // pkg/models/gemini/projection.go). They are evidence, not prose:
  // rendered through onToken they concatenate into the assistant's
  // bubble as one unbroken run of opaque redirect URLs.
  const GROUNDING_AUTHOR = 'gemini/google_search';

  // Returns {query} or {title, uri} for a recognized line, null for
  // anything else — the caller falls back to rendering it as text, so a
  // new projection line kind degrades to today's behaviour rather than
  // vanishing.
  //
  // The title/uri split is greedy on purpose: it anchors on the last
  // " — " before the URL, so a title containing an em-dash of its own
  // stays intact. Vertex omits the title on some chunks, which arrive
  // as a bare URI.
  function parseGroundingLine(text) {
    const s = (text || '').trim();
    if (!s) return null;
    if (s.startsWith('query: ')) return { query: s.slice(7) };
    const titled = /^(.*) — (https?:\/\/\S+)$/.exec(s);
    if (titled) return { title: titled[1], uri: titled[2] };
    if (/^https?:\/\/\S+$/.test(s)) return { title: '', uri: s };
    return null;
  }

  // The URI is an opaque vertexaisearch redirect, so its hostname is
  // the same useless string on every source. The title Vertex ships
  // alongside is already the publisher's domain — prefer it, and fall
  // back to the hostname only when there is no title at all.
  function sourceLabel(title, uri) {
    if (title) return title;
    try {
      return new URL(uri).hostname.replace(/^www\./, '');
    } catch {
      return uri;
    }
  }

  // How long a turn stays open after turn-complete arrives.
  //
  // core-agent emits the completion frame from its turn loop while the
  // final agent frame is still in flight behind it: measured against a
  // live backend (gemini-3.7-flash on Vertex, one-sentence answer), the
  // reply landed 38ms *after* turn-complete. Closing on arrival stamps
  // the footer first, so the transcript reads
  //
  //   4.58s · 5009↑ / 7↓ tokens · $0.0004
  //   AGENT: The capital of Portugal is Lisbon.
  //
  // — the summary above the thing it summarises. So the turn lingers
  // for a beat and trailing frames still land inside it. The window is
  // an order of magnitude over the measured skew and short enough that
  // the footer still reads as instant; anything that plainly belongs to
  // the *next* turn flushes it early (see flushTurnClose call sites),
  // so a slow straggler costs a late footer, never a mis-attached one.
  const TURN_CLOSE_GRACE_MS = 400;

  // ── Replayed history ───────────────────────────────────────────────
  //
  // How much of a reattached session's transcript is on screen to start
  // with, and how much more each "show earlier" reveals. The rest is
  // held in memory (AttachCoreReplay.ReplayHistory) rather than
  // re-fetched, because the server already re-streamed the whole log
  // when we attached — see the comment there.
  const HISTORY_TURNS_INITIAL = 3;
  const HISTORY_TURNS_MORE = 5;

  // Scrolling to within this much of the top asks for more, the way a
  // chat app does. The button says the same thing out loud, for anyone
  // arriving by keyboard or not thinking to try.
  const HISTORY_SCROLL_TRIGGER_PX = 24;

  // The replay burst is over when the first live frame arrives, or when
  // it has been quiet this long — whichever comes first. Generous,
  // because firing mid-burst cuts history off early; the cost of being
  // wrong the other way is a beat of delay on a session that has
  // nothing else to say.
  const HISTORY_SETTLE_MS = 600;

  // usage-update.last_turn carries no prompt_id, so a footer may only
  // claim it when their token counts agree. Two consecutive turns with
  // identical counts would also have identical costs, so that ambiguity
  // is harmless; a mismatch means the payload describes another turn.
  function lastTurnMatches(lt, tokensIn, tokensOut) {
    return !!lt && lt.costUSD > 0 && lt.tokensIn === tokensIn && lt.tokensOut === tokensOut;
  }

  function mk(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  const THINKING_PHRASES = [
    'Thinking',
    'Asking the model…',
    'Reasoning through your request',
    'Coordinating tool calls',
  ];

  // ─── Instance factory ──────────────────────────────────────────────

  function create(opts) {
    const cfg = opts || {};
    const endpoint = cfg.endpoint || '/';
    const token = cfg.token || '';
    const onChange = typeof cfg.onChange === 'function' ? cfg.onChange : function () {};
    // Shell-level slash commands, contributed by whatever mounted this
    // terminal — /theme, /layout, /attach and the rest act on the
    // window, not on a session, so the shell owns them and hands them
    // down. Same descriptor shape as the built-ins below, and they land
    // in the same table for the same reason /help and dispatch share
    // available(): a command listed from one place and dispatched from
    // another is the second read, and the second read is what shipped
    // core-tui#275/#276.
    const shellCommands = Array.isArray(cfg.commands) ? cfg.commands : [];

    // Everything app.js kept in module scope lives here instead — but
    // in the shared stores rather than in this closure, one instance of
    // each per terminal. Through v0.3.0 both stores were singletons,
    // which is why this file grew its own informal copy of them; they
    // are factories now, so the copy is gone and the state a shell
    // wants to read (who is connected, what is running, what it cost)
    // is observable from outside without asking the terminal.
    const session = window.MastState.createSession({
      endpoint: endpoint,
      currentSession: cfg.sessionId || '',
      label: cfg.label || cfg.sessionId || endpoint,
    });
    const connection = window.MastState.createConnection();

    // Renderer-only state, which stays in the closure because nothing
    // outside the transcript can do anything with it: a DOM handle, a
    // half-priced turn, and two flags about how to draw the next row.
    const ui = {
      lastUserPrompt: '',
      lastFooter: null,
      // Most recent usage-update.last_turn, held until a footer claims
      // it: core-agent emits usage-update *before* turn-complete, so
      // the priced-out cost arrives while the turn that earned it has
      // no footer yet, and lastFooter still points at the turn before.
      pendingLastTurn: null,
      // Set once a usage-update has carried turns_total — see the
      // usage-update case for why the local count defers to it.
      serverCountsTurns: false,
      // The "you are watching, not driving" notice, while the session
      // says so. Held rather than re-queried because /clear empties the
      // transcript it lives in.
      observerBanner: null,
      destroyed: false,
    };

    // Reading the two stores. Named because `session.get().turnCount`
    // at forty call sites reads worse than the field it replaced.
    function sess() {
      return session.get();
    }

    const pendingToolCallsByID = new Map();
    // The turn that has seen turn-complete but is still accepting
    // trailing frames: { turn, result, timer }. See TURN_CLOSE_GRACE_MS.
    let closingTurn = null;
    let elapsedTimer = null;

    // ── DOM ──────────────────────────────────────────────────────────

    const root = mk('div', 'term');
    // Which session this transcript belongs to. Nothing styles it; it
    // is here because a shell that keeps several terminals mounted at
    // once (solo.html) otherwise has no way to say *which* one it means
    // from outside — including from a smoke test.
    root.dataset.session = sess().currentSession;

    const screen = mk('div', 'term-screen');
    const out = mk('div', 'term-out');
    screen.appendChild(out);

    const inputRow = mk('div', 'term-input');
    const shell = mk('div', 'term-shell');
    const prefix = mk('span', 'term-prefix');
    prefix.setAttribute('aria-hidden', 'true');
    const caret = mk('span', 'term-caret');
    caret.setAttribute('aria-hidden', 'true');
    const input = document.createElement('textarea');
    input.className = 'term-prompt';
    input.rows = 1;
    input.placeholder = 'ask, instruct, or /command…';
    const sendBtn = mk('button', 'term-btn term-send', 'SEND');
    sendBtn.type = 'button';
    const stopBtn = mk('button', 'term-btn term-stop', 'STOP');
    stopBtn.type = 'button';
    stopBtn.hidden = true;
    stopBtn.title = 'Cancel the current turn';
    shell.append(prefix, caret, input, sendBtn, stopBtn);
    inputRow.appendChild(shell);

    // The hold banner (v1.5.0 §2.8, #70). Between the transcript and
    // the prompt, because that is the order the questions arrive in —
    // what happened, what you can do about it, where you type — and
    // because a gate drawn anywhere else is a gate you can type past.
    // Not at the top of the transcript, which is the observer notice's
    // slot: that one is a caveat about the whole session, this one is a
    // barrier across the control directly below it.
    const holdBar = mk('div', 'term-hold');
    holdBar.hidden = true;
    const holdWhy = mk('div', 'term-hold-why', 'HELD');
    const holdDetail = mk('div', 'term-hold-detail');
    const holdActions = mk('div', 'term-hold-actions');
    const contBtn = mk('button', 'term-btn term-hold-go', 'CONTINUE');
    contBtn.type = 'button';
    contBtn.title = 'Release the hold and carry on from where it stopped';
    const abandonBtn = mk('button', 'term-btn term-hold-drop', 'ABANDON');
    abandonBtn.type = 'button';
    abandonBtn.title = 'Release the hold and drop the held work';
    const holdHint = mk('span', 'term-hold-hint', '');
    holdActions.append(contBtn, abandonBtn, holdHint);
    holdBar.append(holdWhy, holdDetail, holdActions);

    const statusRow = mk('div', 'term-status');
    const sConn = mk('span', 'term-stat term-conn', '⬤ disconnected');
    const sModel = mk('span', 'term-stat', '—');
    const sTurns = mk('span', 'term-stat', 'T0');
    const sCost = mk('span', 'term-stat', '$0.00');
    const sElapsed = mk('span', 'term-stat term-elapsed', 't+ —');
    // "A turn is running in here that I did not start." Hidden whenever
    // this browser is the one driving, because the elapsed timer to its
    // left already says that and says it better. Only knowable from
    // 1.12.0 onwards: before it, a mid-turn GET /status answered "idle"
    // and there was nothing truthful to draw here (#93, core-agent#896).
    const sRun = mk('span', 'term-stat term-inflight', '⟳ turn in flight');
    sRun.hidden = true;
    sRun.title = 'The agent is working on a turn this browser did not dispatch';
    statusRow.append(sConn, sModel, sTurns, sCost, sElapsed, sRun);

    root.append(screen, holdBar, inputRow, statusRow);
    setPrefix();

    // ── Rendering (ported from app.js, bound to `out`) ───────────────

    // Rows land at the bottom of the live transcript. The replayed
    // history block is the one exception: it draws with these same
    // helpers, into its own container, stamped with the wire's clock
    // instead of this one's. Redirecting the two things every helper
    // does — where it puts the row, what time it claims — keeps that
    // from becoming a second copy of the renderer.
    let sink = out;
    let sinkStamp = null;

    function place(el) {
      sink.appendChild(el);
    }

    function stamp() {
      return sinkStamp || nowStamp();
    }

    function withSink(target, fn) {
      const prev = sink;
      sink = target;
      try {
        fn();
      } finally {
        sink = prev;
        sinkStamp = null;
      }
    }

    function scroll() {
      // Drawing off to one side; the live view hasn't moved.
      if (sink !== out) return;
      out.scrollTop = out.scrollHeight;
    }

    function makeMsgHead(role) {
      const head = mk('div', 'msg-head');
      head.appendChild(mk('span', 'msg-role', role + ':'));
      head.appendChild(mk('span', 'msg-time', '[' + stamp() + ']'));
      return head;
    }

    function addMessage(role, content, extraClass) {
      const div = mk('div', 'message ' + role + (extraClass ? ' ' + extraClass : ''));
      if (role === 'assistant') {
        div.appendChild(makeMsgHead('AGENT'));
        const md = mk('div', 'md-content');
        md.innerHTML = renderMarkdown(content);
        div.appendChild(md);
        // The markdown source, kept because the rendered DOM is lossy
        // and /export wants what the agent actually said.
        div.dataset.source = content;
        addMessageActions(div, content);
      } else if (role === 'user') {
        div.appendChild(makeMsgHead('USER'));
        div.appendChild(mk('div', 'msg-body', content));
      } else {
        div.dataset.ts = stamp();
        div.textContent = content;
      }
      place(div);
      scroll();
      return div;
    }

    // `getText` is a thunk because a streaming row's final text isn't
    // known when the chips are attached. `allowRetry` is false for a
    // replayed row: RETRY re-sends ui.lastUserPrompt, which is this
    // view's last prompt and has nothing to do with a reply the log
    // remembers from before we attached.
    function addMessageActions(el, textOrGetter, allowRetry) {
      const text = () => (typeof textOrGetter === 'function' ? textOrGetter() : textOrGetter);
      const row = mk('div', 'msg-actions');

      const copy = mk('button', 'msg-action', 'COPY');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(text() || '');
          copy.textContent = 'COPIED';
          copy.classList.add('done');
          setTimeout(() => {
            copy.textContent = 'COPY';
            copy.classList.remove('done');
          }, 1200);
        } catch {
          copy.textContent = 'BLOCKED';
          setTimeout(() => {
            copy.textContent = 'COPY';
          }, 1200);
        }
      });

      row.appendChild(copy);

      if (allowRetry !== false) {
        const retry = mk('button', 'msg-action', 'RETRY');
        retry.type = 'button';
        retry.title = 'Re-send the prompt that produced this response';
        retry.addEventListener('click', () => {
          if (!ui.lastUserPrompt || connection.isRunning()) return;
          submit(ui.lastUserPrompt);
        });
        row.appendChild(retry);
      }

      el.appendChild(row);
    }

    function addSystemMessage(text) {
      return addMessage('system', text, '');
    }

    // Slash output arrives as HTML from SlashRender, which escapes every
    // interpolated value itself — see slash-render.js's escapeHTML.
    function addSystemMessageHTML(html) {
      const div = mk('div', 'message system cmd-output');
      div.dataset.ts = stamp();
      div.innerHTML = html;
      place(div);
      scroll();
      return div;
    }

    // ── Observer mode ────────────────────────────────────────────────
    //
    // features.observer_mode says this panel is watching a session that
    // something else is driving. Worth saying out loud, because a
    // transcript that moves on its own looks exactly like one you are
    // driving, and the difference decides whether typing accomplishes
    // anything.
    //
    // Two variants, per features.live_agent:
    //   read-only (!live_agent) — the agent is autonomous, and a prompt
    //     from here is a no-op or an indefinite queue.
    //   read-write (live_agent) — your prompts do drive it, but so can
    //     everyone else attached, and they see what you send.
    //
    // Pinned to the top of the transcript rather than appended as a
    // system row. app.js appended, so the notice scrolled away with the
    // second screenful — which is around when an operator starts
    // wondering why nothing is responding.
    function isObserverCaps(caps) {
      return !!(caps && caps.features && caps.features.observer_mode === true);
    }

    function applyObserverMode(features) {
      const isObserver = !!(features && features.observer_mode === true);
      if (!isObserver) {
        if (ui.observerBanner) {
          ui.observerBanner.remove();
          ui.observerBanner = null;
        }
        return;
      }
      if (!ui.observerBanner) {
        ui.observerBanner = mk('div', 'term-observer');
        out.insertBefore(ui.observerBanner, out.firstChild);
      }
      ui.observerBanner.textContent =
        features.live_agent === true
          ? 'Live session — your messages drive the agent, and everyone attached sees them.'
          : 'Attached as observer — the agent runs autonomously; events stream below.';
    }

    // ── Permission prompts ───────────────────────────────────────────
    //
    // app.js answered these in a global modal. A workspace can't reuse
    // that: four panels can be prompted at once, and one modal has no
    // way to say which session it speaks for — nor to hold the second
    // request while the first is open. So the request renders inline,
    // in the transcript of the terminal that raised it. The panel is
    // already the thing that identifies the session, and scrollback
    // gives a free record of what was asked and what was answered.
    //
    // Three buttons rather than app.js's two-plus-a-scope-checkbox.
    // There the checkbox upgrades allow-once → allow-session-tool on
    // submit; spelling both out is the same two decisions with one
    // less piece of hidden state, which matters more on a card this
    // small.

    function addPermsRequest(frame) {
      const div = mk('div', 'message perms-request');
      div.dataset.promptId = frame.id;

      const head = mk('div', 'msg-head');
      head.appendChild(mk('span', 'msg-role', 'permission:'));
      head.appendChild(mk('span', 'msg-time', '[' + stamp() + ']'));
      div.appendChild(head);

      div.appendChild(mk('div', 'perms-tool', frame.tool || frame.kind || 'tool'));
      if (frame.detail) div.appendChild(mk('div', 'perms-detail', frame.detail));

      const meta = [];
      if (frame.verb) meta.push('verb ' + frame.verb);
      if (frame.access) meta.push('access ' + frame.access);
      if (frame.source) meta.push('source ' + frame.source);
      if (meta.length) div.appendChild(mk('div', 'perms-meta', meta.join('  ·  ')));

      // Wire-stable decision strings from core-agent/pkg/attach/
      // prompter.go's DecisionFromWire mapping.
      const actions = mk('div', 'perms-actions');
      [
        ['DENY', 'deny'],
        ['ALLOW ONCE', 'allow-once'],
        ['ALLOW SESSION', 'allow-session-tool'],
      ].forEach(([label, decision]) => {
        const b = mk('button', 'term-btn', label);
        b.type = 'button';
        b.addEventListener('click', () => resolvePermsRequest(div, frame, decision));
        actions.appendChild(b);
      });
      div.appendChild(actions);

      place(div);
      scroll();
      return div;
    }

    // Records the decision in the card before the POST, not after: the
    // operator gets immediate feedback, and a double-click can't send
    // two responses for one frame.
    async function resolvePermsRequest(div, frame, decision) {
      if (div.dataset.resolved) return;
      div.dataset.resolved = decision;
      const actions = div.querySelector('.perms-actions');
      if (actions) actions.replaceChildren(mk('span', 'perms-outcome', decision));
      const pr = connection.getPrompter();
      if (!pr) return;
      try {
        const out = await pr.respond(frame.id, decision);
        recordApprover(div, out);
      } catch (e) {
        addSystemMessage(describeError(e, 'perms respond failed: '));
      }
    }

    // What the daemon wrote in the audit log for the click that just
    // happened (v1.10.0, core-agent#830). Three answers, and they are
    // three because collapsing any two loses the one thing worth
    // saying:
    //
    //   a name          — this decision is attributable to that
    //                     identity, which on a shared session is not
    //                     necessarily the person at this keyboard.
    //   unattributed    — the backend can attribute and did not, so
    //                     the log will not name anyone. Worth knowing
    //                     at the moment of clicking rather than during
    //                     the incident review that goes looking.
    //   nothing         — a pre-1.10.0 backend, where the field does
    //                     not exist. "Unattributed" there would be
    //                     inventing a fact about a daemon that was
    //                     never asked.
    //
    // Never this browser's own identity. It is the likeliest author
    // and the most damaging to assume, since the whole value of the
    // line is that it was not assumed.
    function recordApprover(div, out) {
      const attributes =
        typeof client.protocolAtLeast === 'function' && client.protocolAtLeast('1.10.0');
      if (!attributes) return;
      const by = out && typeof out.approver === 'string' ? out.approver : '';
      const el = div.querySelector('.perms-outcome');
      if (!el) return;
      const note = mk('span', 'perms-approver', by ? 'by ' + by : 'unattributed');
      el.after(note);
    }

    // The perms stream is a SECOND EventSource, opened alongside the
    // main one and torn down with the terminal.
    function openPromptStream() {
      closePromptStream();
      const Prompter = window.AttachCorePrompter && window.AttachCorePrompter.Prompter;
      if (!Prompter) return;
      const pr = new Prompter({
        endpoint: endpoint,
        token: token,
        sessionId: sess().currentSession,
        onPrompt: (frame) => {
          if (ui.destroyed || !frame || !frame.id) return;
          addPermsRequest(frame);
        },
        onTerminal: () => {
          if (ui.destroyed) return;
          addSystemMessage(
            'Perms stream unavailable — this agent does not support interactive prompts, or the stream permanently failed.'
          );
        },
      });
      connection.setPrompter(pr);
      pr.connect();
    }

    function closePromptStream() {
      const pr = connection.getPrompter();
      if (!pr) return;
      try {
        pr.disconnect();
      } catch {
        /* best effort */
      }
      connection.setPrompter(null);
    }

    function addTurnFooter(result) {
      const div = mk('div', 'turn-footer');
      const tokensIn = result.tokens.in || 0;
      const tokensOut = result.tokens.out || 0;
      let cost = result.costUSD || 0;
      // turn-complete.cost_usd is optional and core-agent omits it, so
      // the number usually arrives on usage-update.last_turn — ahead of
      // this footer existing. See ui.pendingLastTurn.
      if (cost <= 0 && lastTurnMatches(ui.pendingLastTurn, tokensIn, tokensOut)) {
        cost = ui.pendingLastTurn.costUSD;
        ui.pendingLastTurn = null;
      }
      div.dataset.totalMs = String(result.totalMs || 0);
      div.dataset.tokensIn = String(tokensIn);
      div.dataset.tokensOut = String(tokensOut);
      div.dataset.costUsd = String(cost);
      renderTurnFooter(div);
      place(div);
      scroll();
      return div;
    }

    function renderTurnFooter(el) {
      const totalMs = Number(el.dataset.totalMs) || 0;
      const tIn = Number(el.dataset.tokensIn) || 0;
      const tOut = Number(el.dataset.tokensOut) || 0;
      const cost = Number(el.dataset.costUsd) || 0;
      const parts = [`${(totalMs / 1000).toFixed(2)}s`, `${tIn}↑ / ${tOut}↓ tokens`];
      if (cost > 0) parts.push('$' + cost.toFixed(6));
      el.textContent = parts.join('  ·  ');
    }

    // Back-fills a stamped footer for servers that emit turn-complete
    // before usage-update. No-op when the payload describes a different
    // turn, or when the displayed cost already matches.
    function backfillTurnFooter(el, lastTurn) {
      if (!el) return;
      const tokensIn = Number(el.dataset.tokensIn) || 0;
      const tokensOut = Number(el.dataset.tokensOut) || 0;
      if (!lastTurnMatches(lastTurn, tokensIn, tokensOut)) return;
      if ((Number(el.dataset.costUsd) || 0) === lastTurn.costUSD) return;
      el.dataset.costUsd = String(lastTurn.costUSD);
      renderTurnFooter(el);
    }

    // One search row per turn, accumulating queries, rather than a row
    // per query: a single grounded answer routinely issues four or five
    // searches, and in a panel this narrow a stack of near-identical
    // rows pushes the reply off screen.
    function addSearchQueryRow() {
      const div = mk('div', 'message builtin-tool grounding-search');
      div.appendChild(mk('span', 'tool-ts', '[' + stamp() + ']'));
      div.appendChild(mk('span', 'builtin-tool-label', '🔍 Search'));
      div.appendChild(mk('code', '', ''));
      place(div);
      scroll();
      return div;
    }

    function appendSearchQuery(el, query) {
      if (!el) return;
      const code = el.querySelector('code');
      code.textContent = code.textContent ? code.textContent + '  ·  ' + query : query;
      scroll();
    }

    function addSourcesStrip() {
      const div = mk('div', 'message citation-sources');
      div.appendChild(mk('span', 'citation-sources-label', 'Sources:'));
      place(div);
      scroll();
      return div;
    }

    function appendSource(el, title, uri) {
      if (!el) return;
      const a = mk(
        'a',
        '',
        '[' + (el.querySelectorAll('a').length + 1) + '] ' + sourceLabel(title, uri)
      );
      a.href = uri;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = title ? title + ' — ' + uri : uri;
      el.appendChild(a);
      scroll();
    }

    function addToolPendingMessage(server, tool) {
      const div = mk('div', 'message tool-pending');
      const headerRow = mk('div', 'tool-row');
      headerRow.innerHTML =
        '<span class="tool-ts">[' +
        stamp() +
        ']</span>' +
        '<span class="tool-icon">⚒</span>' +
        '<span class="tool-verb">Using</span>' +
        '<code class="tool-name">' +
        escapeHtml(server) +
        '_' +
        escapeHtml(tool) +
        '</code>' +
        '<span class="tool-latency"></span>';
      div.appendChild(headerRow);
      place(div);
      scroll();
      return div;
    }

    function completeToolMessage(el, latencyMs, errMsg, resultJSON) {
      if (!el) return;
      el.classList.remove('tool-pending');
      el.classList.add('tool-done');
      if (errMsg) el.classList.add('tool-error');

      const icon = el.querySelector('.tool-icon');
      const verb = el.querySelector('.tool-verb');
      const latencyEl = el.querySelector('.tool-latency');
      if (icon) icon.textContent = errMsg ? '✗' : '✓';
      if (verb) verb.textContent = errMsg ? 'Failed' : 'Used';
      if (latencyEl && latencyMs > 0) latencyEl.textContent = '(' + latencyMs.toFixed(0) + 'ms)';

      const headerRow = el.querySelector('.tool-row');
      if (!headerRow) return;
      const payload = errMsg || resultJSON;
      if (!payload) return;

      const c = mk('span', 'tool-caret', '▶');
      headerRow.appendChild(c);
      headerRow.classList.add('tool-row-expandable');

      const body = mk('div', 'tool-body');
      const viewer = mk('div', 'json-viewer');
      try {
        viewer.textContent = JSON.stringify(JSON.parse(payload), null, 2);
      } catch {
        viewer.textContent = payload;
      }
      body.appendChild(viewer);
      el.appendChild(body);

      headerRow.addEventListener('click', () => {
        const isOpen = el.classList.toggle('open');
        c.textContent = isOpen ? '▼' : '▶';
      });
    }

    function createStreamingMessage(allowRetry) {
      const div = mk('div', 'message assistant');
      div.appendChild(makeMsgHead('AGENT'));
      const md = mk('div', 'md-content');
      div.appendChild(md);
      place(div);
      const ref = { el: div, md: md, text: '' };
      addMessageActions(div, () => ref.text, allowRetry);
      return ref;
    }

    function updateStreamingMessage(msg, tokenText) {
      msg.text += tokenText;
      msg.md.innerHTML = renderMarkdown(msg.text);
      msg.el.dataset.source = msg.text;
      scroll();
    }

    function startThinking() {
      const el = mk('div', 'thinking');
      const pick = () => THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
      el.textContent = pick();
      place(el);
      scroll();
      const interval = setInterval(() => {
        el.textContent = pick();
      }, 5000);
      return {
        stop() {
          clearInterval(interval);
          el.remove();
        },
      };
    }

    // ── Chrome ───────────────────────────────────────────────────────

    function setPrefix() {
      const sid = sess().currentSession || 'mast';
      prefix.textContent = '[' + sid.slice(0, 12) + '] ~>';
    }

    function setConnState(state) {
      connection.setState(state);
      const glyph = state === 'connected' ? '⬤' : state === 'connecting' ? '◐' : '○';
      sConn.textContent = glyph + ' ' + state;
      sConn.dataset.state = state;
      root.dataset.conn = state;
      // The status chain lives and dies with the stream. Attaching is
      // also the moment the answer matters most and is least likely to
      // be known: a session someone else has been driving for a minute
      // sends no frame to say so, and the seed status-update says
      // 'paused' if it is held. So the first read is immediate rather
      // than one cadence away; a drop stops the chain rather than
      // polling a backend the stream has already given up on.
      if (state === 'connected') refreshStatus();
      else {
        clearTimeout(statusTimer);
        statusTimer = 0;
      }
      onChange(api, 'conn');
    }

    // setRunning is about *this browser's* turn, and deliberately stays
    // that way: it is what disables SEND, reveals STOP and starts the
    // elapsed timer, and none of those are things to do to an operator
    // because somebody else's turn is in flight. The wider question —
    // is this agent working at all — is serverRunning() below, and the
    // seam ORs the two (#93).
    function setRunning(running) {
      connection.setIsRunning(running);
      sendBtn.disabled = running;
      stopBtn.hidden = !running;
      root.classList.toggle('term-busy', running);
      renderRunning();
      onChange(api, 'busy');
    }

    // What the *server* says is executing, from the three places it can
    // say so. OR-ed rather than ranked, because they are one fact seen
    // through three windows of different ages:
    //
    //   turnInFlight  GET /status's bool (1.12.0). The only one that
    //                 survives a hold — pause outranks running in
    //                 `state`, so a session parked mid-turn reports
    //                 "paused" and this is what says the turn it
    //                 interrupted is still going.
    //   runState      GET /status's `state`, reachable as "running"
    //                 only from 1.12.0; before that the run loop had no
    //                 signal to read and a mid-turn poll said "idle".
    //   turnState     the status-update frame's turn_state, where the
    //                 broadcaster has already folded turn_in_flight
    //                 into 'streaming'. The fast one, and the only one
    //                 on a backend too old to poll usefully.
    //
    // A false here is never louder than a true: every source is
    // omitempty or absent on an older backend, so "no" and "nobody
    // said" look alike, and treating the pair as a veto over a running
    // turn we can see locally would make a 2026-02 daemon look idle
    // mid-stream.
    function serverRunning(s) {
      const st = s.status;
      return !!st.turnInFlight || st.runState === 'running' || st.turnState === 'streaming';
    }

    function renderRunning() {
      sRun.hidden = !(serverRunning(sess()) && !connection.isRunning());
    }

    function updateStatus() {
      const s = sess();
      sModel.textContent = s.currentModel || '—';
      sTurns.textContent = 'T' + s.turnCount;
      sCost.textContent = '$' + s.totalCostUSD.toFixed(s.totalCostUSD < 1 ? 4 : 2);
    }

    // ── The hold ─────────────────────────────────────────────────────
    //
    // Three surfaces, and the split between them is the whole design:
    //
    //   renderHold()  redraws the banner from the store. Idempotent,
    //                 called from every path that could have moved the
    //                 gate, and silent.
    //   narrateHold() writes one line into the transcript, and is
    //                 called from exactly one of those paths.
    //   releaseHold() is the only place a resume is sent.
    //
    // Narration is the `pause` frame's job alone. GET /status carries
    // the same fact about a second later and status-update carries it
    // on every poll, so a second narrator would announce every park
    // twice — and an operator who sees "Session held" twice reasonably
    // concludes it happened twice.

    const HOLD_NO_CONTROLS =
      'This backend advertises no resume route — the hold has to be lifted where it was set.';

    const RESUME_BLURB = {
      continue: 'carrying on from where it stopped.',
      steer: 'the correction goes in first.',
      abandon: 'the held work was dropped.',
    };

    // What an operator asks, in order: was my work killed, and is
    // anything still running. Two facts, deliberately kept apart —
    // upstream folds them into one `state` field where pause outranks
    // running, which is exactly how a hold banner ends up sitting over
    // another four minutes of turn (core-agent#896).
    //
    // #70 asked for a third line — how many background subagents are
    // still going — and it is not here, because there is nowhere
    // truthful to read it from yet. The live roster (GET .../agents)
    // carries no status, and the one number we do get, interrupt's
    // `running_subagents`, only arrives on a Stop, which does not hold.
    // #94 is where subagent status becomes honest (v1.12.0 #897); the
    // line belongs with it rather than as a zero that is always a zero.
    function describeHold(p, inFlight) {
      const bits = [];
      if (p.interrupted && inFlight) bits.push('The turn it interrupted is still unwinding.');
      else if (p.interrupted) bits.push('The turn it interrupted was cancelled.');
      else if (inFlight) bits.push('A turn is still running behind the gate.');
      else bits.push('Nothing was in flight.');
      bits.push('No new turn starts until this is released.');
      if (p.since) {
        const t = new Date(p.since);
        if (!isNaN(t.getTime())) bits.push('Held since ' + t.toLocaleTimeString('en-GB') + '.');
      }
      return bits.join(' ');
    }

    function renderHold() {
      const s = sess();
      const p = s.pause;
      // Drawn on the observation, not on the capability. `paused` is
      // only ever set by something the server told us — a `pause` frame,
      // a status body, or a route's own post-condition — and a flag is
      // not a reason to hide a fact already in hand. emitsPauseEvents()
      // answers "should we expect to hear about this", which is a
      // question about anticipating the state; supportsPause() answers
      // "can this operator do anything about it", and that is the one
      // the buttons below are gated on.
      holdBar.hidden = !p.paused;
      root.classList.toggle('term-held', p.paused);
      input.placeholder = p.paused
        ? 'type a correction to steer, or /continue…'
        : 'ask, instruct, or /command…';
      if (!p.paused) return;
      holdWhy.textContent = p.reason ? 'HELD — ' + p.reason : 'HELD';
      holdDetail.textContent = describeHold(p, s.status.turnInFlight);
      const controls = available({ feature: 'pause' });
      contBtn.hidden = !controls;
      abandonBtn.hidden = !controls;
      holdHint.textContent = controls ? '…or type a correction to steer' : HOLD_NO_CONTROLS;
    }

    function narrateHold(p) {
      addSystemMessage(
        p.paused
          ? 'Session held' + (p.reason ? ' — ' + p.reason : '') + '.'
          : 'Session resumed' + (p.resumeMode ? ' (' + p.resumeMode + ')' : '') + '.'
      );
    }

    // ── The status poll (#93, spec v1.12.0) ──────────────────────────
    //
    // Two facts live on GET /sessions/{sid}/status and nowhere else:
    // `state: "running"`, reachable for the first time in 1.12.0, and
    // `turn_in_flight` beside it. The status-update frame carries
    // neither — the broadcaster folds the bool into
    // turn_state:'streaming' before the frame leaves, and a held
    // session's frame says 'paused' because pause outranks running in
    // the single field it has. A hold banner sitting over another four
    // minutes of turn is the bug that came from believing it, so the
    // only honest answer is to ask.
    //
    // Two cadences, because the question is not always live. Held or
    // in flight, the answer is changing and someone is waiting on it;
    // otherwise this is a background check that another operator, a
    // TUI or a scheduler has started something in here, and once every
    // ten seconds is plenty. Six panels in the spatial shell each run
    // one of these, which is the other reason the idle rate is slow.
    //
    // setTimeout rather than setInterval: a chain cannot overlap with
    // itself on a slow backend, and the delay is recomputed from the
    // state each time rather than from the state when it was armed.
    const STATUS_POLL_MS = 10000;
    const STATUS_POLL_LIVE_MS = 3000;

    let statusTimer = 0;
    let statusPending = false;

    // Gated on the negotiated version, not the capabilities frame: this
    // is a route's behaviour, and `state: "running"` on an older daemon
    // is not wrong so much as never produced. Polling one would spend a
    // request per panel per ten seconds to be told "idle" by a server
    // that has no other answer.
    function pollsStatus() {
      return typeof client.protocolAtLeast === 'function' && client.protocolAtLeast('1.12.0');
    }

    function scheduleStatusPoll() {
      clearTimeout(statusTimer);
      statusTimer = 0;
      if (ui.destroyed || !pollsStatus() || connection.getState() !== 'connected') return;
      const s = sess();
      const live = s.pause.paused || serverRunning(s);
      statusTimer = setTimeout(refreshStatus, live ? STATUS_POLL_LIVE_MS : STATUS_POLL_MS);
    }

    // One read now, and the chain re-armed behind it. Every caller that
    // wants the answer sooner than the cadence would bring it — a fresh
    // hold, a /pause that just landed, a shell bringing a tab to the
    // front — comes through here rather than starting a timer of its
    // own, so there is only ever one.
    function refreshStatus() {
      // Whatever was armed is now this read. Without the clear, a
      // caller that asks early — a `pause` frame, two seconds into a
      // ten-second wait — leaves the old timer to fire as well, and the
      // panel ends up with two chains polling at once.
      clearTimeout(statusTimer);
      statusTimer = 0;
      if (ui.destroyed || !pollsStatus()) return Promise.resolve(null);
      // A tab nobody is looking at still keeps its place in the chain;
      // it just doesn't spend the request. The next visible tick reads
      // the current state anyway, and the browser throttles background
      // timers regardless.
      if (typeof document !== 'undefined' && document.hidden) {
        scheduleStatusPoll();
        return Promise.resolve(null);
      }
      if (statusPending) return Promise.resolve(null);
      statusPending = true;
      return client.getStatus().then(
        (st) => {
          statusPending = false;
          if (ui.destroyed) return null;
          session.applyStatusSnapshot(st);
          renderHold();
          renderRunning();
          onChange(api, 'status');
          scheduleStatusPoll();
          return st;
        },
        () => {
          statusPending = false;
          // A failed poll is not news. The stream is the surface that
          // reports a connection going wrong, and a transcript line per
          // ten seconds would bury it. Keep the chain and stay quiet.
          scheduleStatusPoll();
          return null;
        }
      );
    }

    // Every way out of the gate — /continue, /abandon, the two buttons
    // and a typed steer — lands here, so they cannot drift apart in
    // what they send or what they report.
    async function releaseHold(mode, steer) {
      if (connection.getState() !== 'connected') {
        addSystemMessage('Not connected.');
        return null;
      }
      // The two commands are gated in the table and the two buttons are
      // hidden, but a typed steer arrives here past both — and a resume
      // route this agent doesn't implement is a 501 that reads like a
      // bug. Say the true thing instead.
      if (!available({ feature: 'pause' })) {
        addSystemMessage(HOLD_NO_CONTROLS);
        return null;
      }
      contBtn.disabled = true;
      abandonBtn.disabled = true;
      try {
        const r = (await client.resume(mode, steer)) || {};
        // `resumed: false` with a 200 is the idempotent answer, not a
        // failure: two operator surfaces racing the same click should
        // not produce an error between them.
        if (r.resumed === false) {
          addSystemMessage('The session was not held.');
        } else {
          const m = r.mode || mode || 'continue';
          addSystemMessage('Resumed — ' + (RESUME_BLURB[m] || 'gate open.'));
          // The response body is the server's post-condition, which is
          // an observation and not an assumption — the distinction
          // session.js draws. Applied here so the banner comes down on
          // a backend that answers the route but is slow with the
          // frame; the frame that follows says the same thing.
          if (r.resumed !== false) session.applyPauseEvent({ state: 'resumed', mode: m });
          renderHold();
        }
        return r;
      } catch (e) {
        addSystemMessage(describeError(e, 'Resume failed: '));
        return null;
      } finally {
        contBtn.disabled = false;
        abandonBtn.disabled = false;
      }
    }

    contBtn.addEventListener('click', () => releaseHold('continue'));
    abandonBtn.addEventListener('click', () => releaseHold('abandon'));

    function startElapsed() {
      const start = performance.now();
      sElapsed.textContent = 't+ 0.0s';
      sElapsed.classList.add('active');
      elapsedTimer = setInterval(() => {
        sElapsed.textContent = 't+ ' + ((performance.now() - start) / 1000).toFixed(1) + 's';
      }, 100);
    }

    function stopElapsed() {
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = null;
      sElapsed.classList.remove('active');
    }

    // ── Turn plumbing ────────────────────────────────────────────────

    // Hold a completed turn open for TURN_CLOSE_GRACE_MS. `activeTurn`
    // stays set throughout, so every dispatcher keeps routing into it
    // without knowing this exists — the only difference is when the
    // footer lands.
    function closeTurnSoon(turn, result) {
      flushTurnClose();
      closingTurn = {
        turn: turn,
        result: result,
        timer: setTimeout(flushTurnClose, TURN_CLOSE_GRACE_MS),
      };
    }

    // Stamp the footer now. Called on the timer, and eagerly by anything
    // that proves the turn is over: a frame that belongs to the next
    // one, a new prompt, teardown.
    function flushTurnClose() {
      if (!closingTurn) return;
      const c = closingTurn;
      closingTurn = null;
      clearTimeout(c.timer);
      c.turn.finish(c.result);
    }

    // Externally-driven turns: when events arrive with no operator turn
    // in flight (observer mode, a peer driving the session, or an
    // autonomous run we attached mid-stream) spawn a turn so the
    // dispatchers have somewhere to route instead of dropping frames.
    function beginObserverTurn() {
      let streaming = null;
      const pendingToolEls = [];
      let searchEl = null;
      let sourcesEl = null;
      const seenSources = new Set();
      const startedAt = performance.now();
      root.classList.add('term-observing');

      const turn = {
        observer: true,
        startedAt: startedAt,
        done: false,
        callbacks: {
          onToken(t) {
            if (!streaming) streaming = createStreamingMessage();
            updateStreamingMessage(streaming, t);
          },
          onToolCall(server, tool) {
            streaming = null;
            pendingToolEls.push(addToolPendingMessage(server, tool));
          },
          onToolResult(server, tool, latencyMs, errMsg, resultJSON) {
            completeToolMessage(pendingToolEls.shift(), latencyMs, errMsg, resultJSON);
          },
          onGroundingQuery(query) {
            streaming = null;
            if (!searchEl) searchEl = addSearchQueryRow();
            appendSearchQuery(searchEl, query);
          },
          onGroundingSource(title, uri) {
            streaming = null;
            // Vertex repeats a chunk when the model grounds on the same
            // page from two search rounds; dedupe on the URI so the
            // strip has one pill per distinct source.
            if (seenSources.has(uri)) return;
            seenSources.add(uri);
            if (!sourcesEl) sourcesEl = addSourcesStrip();
            appendSource(sourcesEl, title, uri);
          },
        },
        finish(result) {
          if (this.done) return;
          this.done = true;
          connection.setActiveTurn(null);
          root.classList.remove('term-observing');
          if (result) {
            ui.lastFooter = addTurnFooter(result);
            if (!ui.serverCountsTurns) session.incrementTurnCount();
            updateStatus();
          }
          pendingToolEls.forEach((el) => completeToolMessage(el, 0, 'turn ended', ''));
        },
      };
      connection.setActiveTurn(turn);
      return turn;
    }

    // ── Replayed history ─────────────────────────────────────────────
    //
    // Attaching to a session that has already been running re-streams
    // its whole eventlog at us. Those frames arrive tagged replay:true
    // and used to be dropped on the floor, which is why a reload showed
    // an empty panel over a session mid-conversation (#51).
    //
    // They are drawn instead, above the live stream, dimmed and closed
    // by a rule: this happened before you got here. Only the newest few
    // turns to begin with — the rest sits in the buffer until asked
    // for. No footers, because the log carries no turn-complete to
    // measure and an invented duration is worse than none.

    const replayView = {
      buf: new window.AttachCoreReplay.ReplayHistory({}),
      el: null,
      body: null,
      more: null,
      timer: null,
      // Transcript geometry as of the last scroll event — see
      // onHistoryScroll.
      geom: '',
      // Set once the block has been drawn (or given up on). After that
      // replay frames go back to being dropped: EventSource reconnects
      // on its own and re-streams the same log, and a second copy of
      // the conversation is worse than a missing tail.
      sealed: false,
    };

    function bufferReplay(ev) {
      if (replayView.sealed) return;
      replayView.buf.push(ev);
      clearTimeout(replayView.timer);
      replayView.timer = setTimeout(drawHistory, HISTORY_SETTLE_MS);
    }

    function drawHistory() {
      if (replayView.sealed) return;
      replayView.sealed = true;
      clearTimeout(replayView.timer);
      replayView.timer = null;
      const turns = replayView.buf.newest(HISTORY_TURNS_INITIAL);
      if (!turns.length) return;

      const block = mk('div', 'replay-history');
      const more = mk('button', 'history-more');
      more.type = 'button';
      more.addEventListener('click', showEarlierHistory);
      const body = mk('div', 'history-body');
      const rule = mk('div', 'history-rule');
      rule.appendChild(mk('span', 'history-rule-label', 'earlier in this session'));
      block.append(more, body, rule);
      // Above everything already on screen — including the attach line,
      // which is the moment this history stops.
      out.insertBefore(block, out.firstChild);
      replayView.el = block;
      replayView.body = body;
      replayView.more = more;

      turns.forEach((t) => body.appendChild(renderHistoryTurn(t)));
      updateHistoryMore();
      out.addEventListener('scroll', onHistoryScroll);
      scroll();
    }

    function updateHistoryMore() {
      const older = replayView.buf.olderCount;
      if (older > 0) {
        const n = Math.min(HISTORY_TURNS_MORE, older);
        replayView.more.disabled = false;
        replayView.more.textContent =
          '▲ show ' + n + (n === 1 ? ' earlier turn' : ' earlier turns') + ' · ' + older + ' left';
        return;
      }
      // Nothing older left to hand back. Which kind of nothing matters:
      // the buffer is capped, and a session long enough to hit the cap
      // should not be told its history begins where our memory does.
      replayView.more.disabled = true;
      replayView.more.textContent = replayView.buf.truncated
        ? '· earlier history not kept ·'
        : '· start of this session ·';
    }

    function showEarlierHistory() {
      const turns = replayView.buf.earlier(HISTORY_TURNS_MORE);
      if (!turns.length) {
        updateHistoryMore();
        return;
      }
      // Grow upward without moving what the operator is reading: the
      // transcript keeps its scroll position by taking on exactly the
      // height that appeared above it.
      const wasHeight = out.scrollHeight;
      const wasTop = out.scrollTop;
      const frag = document.createDocumentFragment();
      turns.forEach((t) => frag.appendChild(renderHistoryTurn(t)));
      replayView.body.insertBefore(frag, replayView.body.firstChild);
      out.scrollTop = wasTop + (out.scrollHeight - wasHeight);
      updateHistoryMore();
    }

    function onHistoryScroll() {
      // Only a deliberate trip to the top counts, and most trips there
      // are not deliberate. Two ways the transcript arrives at its own
      // top without anyone asking:
      //
      //   - it fits on screen, so scrollTop is 0 and stays 0;
      //   - it grew a viewport. A 3D panel opens at a fraction of its
      //     final height, and when the browser clamps scrollTop to the
      //     new maximum a transcript parked at the bottom lands at the
      //     top and fires a scroll event nobody caused.
      //
      // So: ignore an unscrollable transcript, and ignore the first
      // scroll after the geometry moved — that one is the layout
      // settling, not a gesture.
      const geom = out.scrollHeight + 'x' + out.clientHeight;
      const settled = geom === replayView.geom;
      replayView.geom = geom;
      if (!replayView.more || replayView.more.disabled) return;
      if (!settled || out.scrollHeight <= out.clientHeight) return;
      if (out.scrollTop > HISTORY_SCROLL_TRIGGER_PX) return;
      showEarlierHistory();
    }

    // One turn of replayed log, rendered with the live helpers into a
    // detached container — see withSink. Deliberately not routed
    // through beginObserverTurn: an observer turn owns activeTurn and
    // ends in a footer, and this is neither active nor timed.
    function renderHistoryTurn(turn) {
      const el = mk('div', 'history-turn');
      let streaming = null;
      const pendingToolEls = [];
      let searchEl = null;
      let sourcesEl = null;
      const seenSources = new Set();

      withSink(el, () => {
        turn.events.forEach((ev) => {
          sinkStamp = wireStamp(ev.ts);
          const d = ev.data || {};
          switch (ev.type) {
            case 'stream-chunk': {
              if (d.author === 'user') {
                // Live, this echo is suppressed — submit() has already
                // drawn the operator's own copy. Replayed, it is the
                // only record of the prompt there is, so it is drawn,
                // minus the delivery wrapper.
                streaming = null;
                addMessage('user', window.AttachCoreReplay.stripInboxWrapper(d.text));
                return;
              }
              if (d.author === GROUNDING_AUTHOR) {
                const line = parseGroundingLine(d.text);
                if (line) {
                  streaming = null;
                  if (line.query !== undefined) {
                    if (!searchEl) searchEl = addSearchQueryRow();
                    appendSearchQuery(searchEl, line.query);
                  } else if (!seenSources.has(line.uri)) {
                    seenSources.add(line.uri);
                    if (!sourcesEl) sourcesEl = addSourcesStrip();
                    appendSource(sourcesEl, line.title, line.uri);
                  }
                  return;
                }
              }
              if (!streaming) streaming = createStreamingMessage(false);
              updateStreamingMessage(streaming, d.text || '');
              return;
            }
            case 'tool-call': {
              streaming = null;
              const name = d.name || '';
              const idx = name.indexOf('_');
              pendingToolEls.push(
                addToolPendingMessage(
                  idx > 0 ? name.substring(0, idx) : '',
                  idx > 0 ? name.substring(idx + 1) : name
                )
              );
              return;
            }
            case 'tool-result': {
              completeToolMessage(
                pendingToolEls.shift(),
                typeof d.latencyMs === 'number' ? d.latencyMs : 0,
                null,
                JSON.stringify(d.response || {}, null, 2)
              );
              return;
            }
            default:
              return;
          }
        });
        // A tool call whose result is off the end of the log — the
        // session was interrupted, or the cap cut between the two.
        pendingToolEls.forEach((toolEl) => completeToolMessage(toolEl, 0, 'no result in log', ''));
      });
      return el;
    }

    function dispatch(ev) {
      // Session-generation gate: attach-core bumps sessionGen on every
      // connect()/selectSession() and tags emitted events with the gen
      // at emit time, so stragglers from a prior stream drop here.
      if (client && typeof ev.gen === 'number' && ev.gen !== client.sessionGen) return;

      switch (ev.type) {
        case 'capabilities':
          session.setCapabilities(ev.data);
          applyObserverMode((ev.data || {}).features);
          // The hold's controls are gated on features.pause, which
          // arrives here — a banner drawn before this frame has to be
          // redrawn after it.
          renderHold();
          // And the status poll is gated on the version, which also
          // arrives here: 'connected' is the socket opening, and this
          // frame is the first thing on it. Asking at connect gets a
          // client that does not yet know what it is talking to and a
          // chain that never arms, which is a poll that silently never
          // happens (#93). This is the real start; the one on connect
          // is for a reconnect, where the version is already known.
          refreshStatus();
          // Attaching to a session someone else is driving means the
          // usage-update that priced the last turn happened before we
          // got here. GET /usage still carries it as last_turn, and
          // that is what the first observer footer needs:
          // turn-complete.cost_usd is optional on the wire, so without
          // this a real turn stamps at $0. Ported from app.js, which
          // took it from coretuiremote's LastTurn fallback. Best
          // effort — a pre-v1.3.0 server 404s here, and a missing
          // snapshot only means waiting for the next usage-update.
          if (isObserverCaps(ev.data)) {
            client.getUsage().then(
              (u) => {
                if (ui.destroyed || !u || !u.last_turn || typeof u.last_turn !== 'object') return;
                const lt = {
                  tokensIn: u.last_turn.tokens_in || 0,
                  tokensOut: u.last_turn.tokens_out || 0,
                  costUSD: u.last_turn.cost_usd || 0,
                };
                ui.pendingLastTurn = lt;
                backfillTurnFooter(ui.lastFooter, lt);
              },
              () => {}
            );
          }
          // Enrich in the background with the resolved identity. The
          // frame carries caller_id, which is what the token presented;
          // /whoami is what the backend made of it, and it's the only
          // source of proxy_by and admin. Failures are swallowed on
          // purpose — an identity slot that can't fill stays empty, and
          // a pre-v1.3.0 server 404s here.
          client.whoami().then(
            (who) => {
              if (ui.destroyed) return;
              session.setWhoami(who);
              onChange(api, 'whoami');
            },
            () => {}
          );
          return;

        case 'status-update': {
          const s = ev.data || {};
          // The agent is generating again: whatever it produces now
          // belongs to the next turn, so close the last one first.
          if (s.turn_state === 'streaming') flushTurnClose();
          // Kept, not just reacted to: this frame is the fastest thing
          // that says the agent is working, it arrives whoever started
          // the turn, and #93's question is whether this session is
          // running at all — not whether we are the one running it.
          if (typeof s.turn_state === 'string') {
            session.patchStatus({ turnState: s.turn_state });
          }
          // turn_state carries the gate too (v1.5.0). Routed through
          // applyPauseStatus rather than set directly so it loses to a
          // `pause` frame applied moments ago — the two can disagree
          // for about a second across a resume.
          session.applyPauseStatus(s);
          // Redraw, never narrate. This frame arrives on every poll and
          // repeats the gate's state each time; the `pause` case below
          // is the one that gets to say a transition happened.
          renderHold();
          renderRunning();
          if (s.model) {
            session.setCurrentModel(s.model);
            updateStatus();
          }
          return;
        }

        // v1.5.0 §2.8. Anyone can park this session — another tab, an
        // embedded TUI, a cost ceiling — so this frame arrives
        // unsolicited, not only in reply to something we sent. No
        // capability gate on the receiving side: a frame the server
        // actually sent is a frame worth believing.
        case 'pause': {
          const was = sess().pause.paused;
          session.applyPauseEvent(ev.data);
          const p = sess().pause;
          // Only a transition is worth a line. An unchanged gate still
          // redraws — the reason or the timestamp may have moved — but
          // it did not happen again.
          if (p.paused !== was) narrateHold(p);
          renderHold();
          // Freshly held: go and find out whether the turn it
          // interrupted is still running. That bool exists on one
          // surface and it is not this frame.
          if (p.paused && !was) refreshStatus();
          onChange(api, 'pause');
          return;
        }

        // v1.7.0 §2.9. An edge, not a state, and explicitly NOT a
        // notification that an alert is waiting — whatever did the
        // waking announces itself through its own frames.
        case 'wake':
          session.recordWake((ev.data || {}).at);
          return;

        case 'usage-update': {
          const u = ev.data || {};
          if (typeof u.cost_usd_total === 'number') session.setTotalCostUSD(u.cost_usd_total);
          // turns_total is the server's own count, so the local
          // increment on turn close is only a fallback for servers that
          // don't send one. It used to be harmless either way — it
          // fired at turn-complete and this overwrote it moments later
          // — but a turn now closes after the usage-update that reports
          // it, so an unconditional increment would count it twice.
          if (typeof u.turns_total === 'number') {
            session.setTurnCount(u.turns_total);
            ui.serverCountsTurns = true;
          }
          if (u.last_turn && typeof u.last_turn === 'object') {
            const lt = {
              tokensIn: u.last_turn.tokens_in || 0,
              tokensOut: u.last_turn.tokens_out || 0,
              costUSD: u.last_turn.cost_usd || 0,
            };
            // Either ordering is legal on the wire: back-fill the
            // footer if it already exists, otherwise hold the payload
            // for addTurnFooter to claim.
            ui.pendingLastTurn = lt;
            backfillTurnFooter(ui.lastFooter, lt);
          }
          updateStatus();
          onChange(api, 'usage');
          return;
        }

        case 'inbox':
          // Nothing in this terminal renders the inbox yet (app.js
          // tracked queued/dequeued for a toast it never drew either),
          // but either state says a prompt is on its way through: the
          // next turn is starting, so the previous one is over whatever
          // is still in flight for it.
          flushTurnClose();
          return;

        case 'turn-complete': {
          const tc = ev.data || {};
          // That turn is over, whoever started it. A real backend says
          // so again in the next status-update, but not every producer
          // sends one — the 001 capture is a status-update:'streaming'
          // and then this, with nothing to retract it — and a
          // turn_state left at 'streaming' is a panel that claims to be
          // working forever (#93). The poll is the backstop; this is the
          // frame that already knows.
          if (sess().status.turnState === 'streaming') {
            session.patchStatus({ turnState: 'idle' });
            renderRunning();
          }
          const open = connection.getActiveTurn();
          if (open) {
            // Measured to *now* rather than to close time — the grace
            // window is the renderer's, not the agent's, and a real
            // backend supplies latency_ms anyway.
            closeTurnSoon(open, {
              totalMs: tc.latency_ms || performance.now() - open.startedAt,
              tokens: { in: tc.tokens_in || 0, out: tc.tokens_out || 0 },
              costUSD: typeof tc.cost_usd === 'number' ? tc.cost_usd : 0,
              toolCalls: [],
            });
          }
          return;
        }

        case 'turn-error': {
          // Close any turn still in its grace window first: the error
          // is its own event, not a reason to void a completed turn's
          // footer.
          flushTurnClose();
          const te = ev.data || {};
          const msg = `${te.kind || 'error'}: ${te.message || ''}${te.hint ? ' (' + te.hint + ')' : ''}`;
          if (te.kind === 'cost_ceiling') {
            addSystemMessage('Cost ceiling reached — session paused until /guardrails reset.');
          }
          const failing = connection.getActiveTurn();
          if (failing) failing.finish(null, new Error(msg));
          else addSystemMessage('Turn error: ' + msg);
          return;
        }

        case 'stream-chunk': {
          // History, not the live stream — buffered and drawn above it.
          if (ev.replay) {
            bufferReplay(ev);
            return;
          }
          // …and the first live frame is what says the history ends
          // here, whatever the settle timer thinks.
          drawHistory();
          // Suppress the prompt echo, as app.js did: a real backend
          // replays the prompt the model received as a user-authored
          // frame ahead of the reply — [Inbox] wrapper and all — so
          // rendering it puts the operator's own message inside the
          // agent bubble. submit() has already drawn the real one. It
          // is also the clearest "a new turn starts here" marker on the
          // wire, so a turn still in its grace window closes on it.
          if (ev.data.author === 'user') {
            flushTurnClose();
            return;
          }
          // Grounding evidence, same reasoning: fanoutAgentFrame keeps
          // the wire decomposition faithful and the renderer decides
          // that a search query is a chip and a grounded source is a
          // pill on a sources strip, not body text. Fixture 007 pins
          // the shape.
          if (ev.data.author === GROUNDING_AUTHOR) {
            const line = parseGroundingLine(ev.data.text);
            if (line) {
              const gTurn = connection.getActiveTurn() || beginObserverTurn();
              if (line.query !== undefined) {
                if (gTurn.callbacks.onGroundingQuery) gTurn.callbacks.onGroundingQuery(line.query);
              } else if (gTurn.callbacks.onGroundingSource) {
                gTurn.callbacks.onGroundingSource(line.title, line.uri);
              }
              return;
            }
            // Unrecognized shape — fall through and render it as text.
          }
          const turn = connection.getActiveTurn() || beginObserverTurn();
          if (turn.callbacks.onToken) turn.callbacks.onToken(ev.data.text);
          return;
        }

        case 'tool-call': {
          if (ev.replay) {
            bufferReplay(ev);
            return;
          }
          drawHistory();
          const turn = connection.getActiveTurn() || beginObserverTurn();
          const { id, name } = ev.data;
          const idx = name.indexOf('_');
          const server = idx > 0 ? name.substring(0, idx) : '';
          const tool = idx > 0 ? name.substring(idx + 1) : name;
          if (turn.callbacks.onToolCall) turn.callbacks.onToolCall(server, tool);
          if (id) pendingToolCallsByID.set(id, { server, tool });
          return;
        }

        case 'tool-result': {
          if (ev.replay) {
            bufferReplay(ev);
            return;
          }
          drawHistory();
          const running = connection.getActiveTurn();
          if (!running || !running.callbacks.onToolResult) return;
          const { id, name, response, latencyMs } = ev.data;
          const idx = (name || '').indexOf('_');
          const server = idx > 0 ? name.substring(0, idx) : '';
          const tool = idx > 0 ? name.substring(idx + 1) : name;
          running.callbacks.onToolResult(
            server,
            tool,
            typeof latencyMs === 'number' ? latencyMs : 0,
            null,
            JSON.stringify(response || {}, null, 2)
          );
          if (id) pendingToolCallsByID.delete(id);
          return;
        }

        default:
          // Unknown event types tolerated forward-compat.
          return;
      }
    }

    const client = new window.AttachClient({
      endpoint: endpoint,
      token: token,
      sessionId: sess().currentSession,
      onConnectionState: setConnState,
      onEvent: dispatch,
    });
    connection.setClient(client);

    function runPrompt(text, callbacks) {
      const startedAt = performance.now();
      return new Promise((resolve, reject) => {
        const turn = {
          callbacks: callbacks,
          startedAt: startedAt,
          done: false,
          finish(result, err) {
            if (this.done) return;
            this.done = true;
            connection.setActiveTurn(null);
            if (err) reject(err);
            else resolve(result);
          },
        };
        connection.setActiveTurn(turn);
        // /inject only, no wake: measured against the mock when app.js
        // still existed, any second wake runs a second turn.
        Promise.resolve()
          .then(() => client.inject(text))
          .catch((e) => turn.finish(null, e));
      });
    }

    // ── Slash commands ───────────────────────────────────────────────
    //
    // Only the generic path: whatever the agent advertises in its
    // capabilities frame is POSTed to /sessions/{sid}/slash/<name> and
    // rendered through SlashRender. The bespoke client-side handlers
    // app.js also carried (/sessions, /model, …) are the next section
    // down; the workspace-scoped ones among them (/attach, /theme, …)
    // went to shell.js, because they belong to the window rather than
    // to any one panel.
    //
    // What this replaces is worse than a missing feature: a leading "/"
    // used to fall through to client.inject(), so typing /tools sent the
    // literal string to the model as chat.

    async function runServerSlash(name, args) {
      const body = args.length > 0 ? { args: args.join(' ') } : {};
      const path =
        '/sessions/' +
        encodeURIComponent(sess().currentSession) +
        '/slash/' +
        encodeURIComponent(name);
      try {
        const res = await client._post(path, body);
        if (window.SlashRender && typeof window.SlashRender.renderSlashResponse === 'function') {
          addSystemMessageHTML(window.SlashRender.renderSlashResponse(res));
        } else {
          addSystemMessage(JSON.stringify(res, null, 2));
        }
      } catch (e) {
        addSystemMessage(describeError(e, '/' + name + ' failed: '));
      }
    }

    // ── Client-side built-ins ────────────────────────────────────────
    //
    // Answered here rather than by the agent, because each one reads a
    // REST endpoint the slash channel doesn't expose, or reads nothing
    // at all. Ported from app.js by PR 2 (#59) and PR 3 (#60) — the
    // classic shell's whole client-side command set had to exist
    // somewhere else before index.html could be deleted, which #61
    // then did.
    //
    // Built-ins win over an advertised name of the same spelling, which
    // is what app.js did and what core-tui settled on. The list of
    // built-in NAMES is its own thing, not a subset of some other
    // predicate — core-tui#289's sibling lesson, and the reason /quit
    // there once got shipped to the agent as prose.
    //
    // Each one is a row in BUILTINS at the bottom of this section, and
    // that table is the only place any of this is written down: /help
    // lists what dispatch will run, because both call availability()
    // on the same row. core-tui#275/#276 was the other arrangement —
    // the listing and the running asking two different questions — and
    // it shipped commands that appeared in help and then refused.

    function renderList(title, groups, opts) {
      if (window.SlashRender && typeof window.SlashRender.renderList === 'function') {
        addSystemMessageHTML(window.SlashRender.renderList(title, groups, opts));
      } else {
        addSystemMessage(title);
      }
    }

    // /tools [source] — the tool catalog, grouped by source.
    // Shape and rationale live in SlashRender.renderTools; this is the
    // fetch, the empty case, and the choice of which system-message
    // flavour the answer needs.
    async function cmdTools(args) {
      let tools;
      try {
        tools = await client.listTools();
      } catch (e) {
        addSystemMessage(describeError(e, '/tools failed: '));
        return;
      }
      if (!tools || tools.length === 0) {
        addSystemMessage('No tools registered on the backend.');
        return;
      }
      const out = window.SlashRender.renderTools(tools, args[0] || '');
      if (out.html) addSystemMessageHTML(out.html);
      else addSystemMessage(out.text);
    }

    // /subagents [list]                — the configured/spawnable roster
    // /subagents events <name> [since] — that subagent's persisted turns
    // /subagents stop <name>           — halt one running subagent
    // core-agent#627/#634 (catalog) + #638/#687 (drill-down) + #897.
    async function cmdSubagents(args) {
      const verb = (args[0] || 'list').toLowerCase();
      if (verb === 'events') {
        await subagentEvents(args.slice(1));
        return;
      }
      if (verb === 'stop') {
        await stopSubagent(args.slice(1));
        return;
      }
      let subs;
      try {
        subs = await client.listConfiguredSubagents();
      } catch (e) {
        addSystemMessage(describeError(e, '/subagents failed: '));
        return;
      }
      if (!subs || subs.length === 0) {
        addSystemMessage('No subagents configured on the backend.');
        return;
      }
      renderList(
        `Configured subagents (${subs.length})`,
        [
          {
            items: subs.map((s) => ({
              name: s.name,
              tags: [s.model, s.modes && s.modes.length ? s.modes.join('/') : ''].filter(Boolean),
              description: s.description,
            })),
          },
        ],
        { summary: '/subagents events <name> [since] to drill in · stop <name> to halt one' }
      );
    }

    // /subagents stop <name> — the only way to reach a runaway
    // subagent. Interrupting the parent cancels the parent's turn and
    // leaves the loop inside a spawned subagent running, which is why
    // the route exists at all.
    //
    // READ THE 200, NOT `stopped`. Through v1.11.0 both "I killed it"
    // and "it had already finished" answered `stopped: true`, so an
    // operator who stopped a subagent that completed thirty seconds
    // earlier was told they had stopped it. v1.12.0 (core-agent#897)
    // split them, and the split only means something on a backend old
    // enough to be asked — hence the version gate on the wording. The
    // claim the 200 itself makes is the same either way: it is not
    // running now.
    //
    // 404 is a miss, not a finished subagent: the manager has never
    // registered that name.
    async function stopSubagent(args) {
      const name = args[0];
      if (!name) {
        addSystemMessage('Usage: /subagents stop <name>');
        return;
      }
      let out;
      try {
        out = await client.stopSubagent(name);
      } catch (e) {
        addSystemMessage(describeError(e, `/subagents stop ${name} failed: `));
        return;
      }
      const honest =
        typeof client.protocolAtLeast === 'function' && client.protocolAtLeast('1.12.0');
      const ended = out && typeof out.status === 'string' && out.status ? out.status : '';
      const as = ended ? ` It ended as "${ended}".` : '';
      if (!honest) {
        // The backend cannot distinguish, so neither will we. Only the
        // post-condition is claimed.
        addSystemMessage(`Subagent "${name}" is no longer running.`);
        return;
      }
      if (out && out.stopped === false) {
        addSystemMessage(
          `Subagent "${name}" had already finished before the stop arrived — this call did not ` +
            `stop it.${as}`
        );
        return;
      }
      addSystemMessage(`Stopped subagent "${name}".${as}`);
    }

    // The subagent-events path is qualified by app, and a terminal is
    // constructed from a session id alone — the app is a fact only GET
    // /sessions carries. app.js could read it off the sidebar's last
    // snapshot; a terminal has no sidebar, so it asks, and caches the
    // answer in the store where the shell around it can use it too.
    //
    // Reports the failure itself rather than returning empty, because
    // "which app" is not a question the operator can answer and the two
    // ways to fail here read very differently.
    async function currentApp() {
      const sid = sess().currentSession;
      const cached = (sess().sessions || []).find((s) => s.id === sid);
      if (cached && cached.app) return cached.app;
      let rows;
      try {
        rows = await client.listSessions();
      } catch (e) {
        addSystemMessage(describeError(e, 'could not resolve the app for this session: '));
        return '';
      }
      session.setSessions(rows);
      const row = rows.find((s) => s.id === sid);
      if (!row || !row.app) {
        addSystemMessage(`Session ${sid} is not in this backend's session list.`);
        return '';
      }
      return row.app;
    }

    async function subagentEvents(args) {
      const name = args[0];
      if (!name) {
        addSystemMessage('Usage: /subagents events <name> [since]');
        return;
      }
      const app = await currentApp();
      if (!app) return;
      const since = Number(args[1]);
      try {
        const out = await client.getSubagentEvents(app, name, {
          since: Number.isFinite(since) ? since : undefined,
        });
        const events = out.events || [];
        if (events.length === 0) {
          addSystemMessage(`No persisted events for subagent "${name}" yet.`);
          return;
        }
        // Tail preview; `since` pages further back once next_since is
        // known, which is why it's printed rather than swallowed.
        const preview = events
          .slice(-10)
          .map((e) => '  #' + e.seq + ' ' + window.SlashRender.summarizeAgentEvent(e.event))
          .join('\n');
        addSystemMessage(
          `Subagent "${name}" — ${events.length} event(s) (next_since=${out.next_since}` +
            (out.truncated ? ', truncated' : '') +
            '):\n' +
            preview
        );
      } catch (e) {
        addSystemMessage(describeError(e, '/subagents events failed: '));
      }
    }

    // /whoami — who the backend resolved this caller to.
    //
    // `capabilities.caller_id` arrives on the first frame and is the
    // identity the token *presented*; this is the one the backend
    // resolved it to, plus proxy_by and admin. Those two are why the
    // round trip is worth making: "acting on behalf of" and "this
    // session can do more than you think" are not derivable from the
    // first frame, and both change what an operator should believe.
    async function cmdWhoami() {
      try {
        const who = await client.whoami();
        session.setWhoami(who);
        onChange(api, 'whoami');
        addSystemMessage(describeWhoami(sess().whoami));
      } catch (e) {
        addSystemMessage(describeError(e, '/whoami failed: '));
      }
    }

    // Folds a GET /usage snapshot into the store. Every field is
    // optional and a missing one leaves the existing value alone rather
    // than zeroing it: the snapshot is a repair for a client that
    // missed usage-update frames, and a repair that can erase what the
    // stream already delivered is worse than no repair.
    function applyUsageSnapshot(u) {
      if (!u || typeof u !== 'object') return;
      const patch = {};
      const o = u.overall;
      if (o && typeof o === 'object') {
        if (typeof o.tokens_in === 'number') patch.tokensIn = o.tokens_in;
        if (typeof o.tokens_out === 'number') patch.tokensOut = o.tokens_out;
        if (typeof o.cost_usd === 'number') patch.costUSD = o.cost_usd;
        if (typeof o.turns === 'number') patch.turns = o.turns;
      }
      if (u.per_model && typeof u.per_model === 'object') {
        const byModel = {};
        Object.keys(u.per_model).forEach((m) => {
          const b = u.per_model[m] || {};
          byModel[m] = {
            tokensIn: b.tokens_in || 0,
            tokensOut: b.tokens_out || 0,
            costUSD: b.cost_usd || 0,
            turns: b.turns || 0,
          };
        });
        patch.byModel = byModel;
      }
      if (u.last_turn && typeof u.last_turn === 'object') {
        patch.lastTurn = {
          tokensIn: u.last_turn.tokens_in || 0,
          tokensInCached: u.last_turn.tokens_in_cached || 0,
          tokensOut: u.last_turn.tokens_out || 0,
          costUSD: u.last_turn.cost_usd || 0,
          model: u.last_turn.model || '',
        };
      }
      session.patchUsage(patch);
      // The status bar reads these two, not usage.*, because they're
      // updated eagerly at turn close before usage-update lands. Keep
      // them in step or /usage and the status bar disagree on screen.
      if (typeof patch.costUSD === 'number') session.setTotalCostUSD(patch.costUSD);
      if (typeof patch.turns === 'number') {
        session.setTurnCount(patch.turns);
        ui.serverCountsTurns = true;
      }
      updateStatus();
    }

    // /usage — session totals from GET /usage.
    //
    // The per-turn footer already prices each turn as it lands, and the
    // status bar carries a running cost; neither answers "what has this
    // session cost me, by model", which is the question that decides
    // whether to keep going. The snapshot also repairs totals for a
    // client that attached mid-session and never saw the earlier
    // usage-update frames.
    async function cmdUsage() {
      let u;
      try {
        u = await client.getUsage();
      } catch (e) {
        addSystemMessage(describeError(e, '/usage failed: '));
        return;
      }
      applyUsageSnapshot(u);
      const s = sess().usage;
      const lines = [
        'Session usage',
        `  Turns:  ${s.turns}`,
        `  Tokens: ${s.tokensIn} in · ${s.tokensOut} out`,
        `  Cost:   $${s.costUSD.toFixed(4)}`,
      ];
      const models = Object.keys(s.byModel).sort();
      models.forEach((m, i) => {
        const b = s.byModel[m];
        lines.push(
          `  ${i === 0 ? 'Models:' : '       '} ${m} (${b.turns} turn${b.turns === 1 ? '' : 's'}, ` +
            `${b.tokensIn} in / ${b.tokensOut} out, $${b.costUSD.toFixed(4)})`
        );
      });
      addSystemMessage(lines.join('\n'));
    }

    // /mcp — the same catalog /tools reads, bucketed by MCP server.
    // A different question ("which of my servers is contributing
    // what"), so a different command; the bucketing rules and the
    // attribution fallback live in SlashRender with /tools'.
    async function cmdMcp() {
      let tools;
      try {
        tools = await client.listTools();
      } catch (e) {
        addSystemMessage(describeError(e, '/mcp failed: '));
        return;
      }
      const servers = window.SlashRender.groupToolsByServer(tools);
      if (servers.length === 0) {
        addSystemMessage(
          "No MCP servers are contributing tools. Configure them in the backend's .agents/mcp.json."
        );
        return;
      }
      renderList(
        `MCP servers (${servers.length})`,
        servers.map((s) => ({
          header: `${s.name} — ${s.status}`,
          items: s.tools,
        }))
      );
    }

    // /specialists [name] — the same catalog /subagents lists, with the
    // model, the modes each one runs in, and since v1.9.0
    // (core-agent#768) the tools it was granted. app.js kept both names
    // for the same endpoint (core-agent#627/#634) and so do we:
    // /subagents answers "what can I drill into", /specialists "what
    // can I spawn, on what, and with what reach".
    //
    // The grant's absence is the interesting case and the renderer
    // handles it — see SlashRender.renderSpecialists.
    async function cmdSpecialists(args) {
      let specs;
      try {
        specs = await client.listConfiguredSubagents();
      } catch (e) {
        addSystemMessage(describeError(e, '/specialists failed: '));
        return;
      }
      if (!specs || specs.length === 0) {
        addSystemMessage('No specialists registered on the backend.');
        return;
      }
      const out = window.SlashRender.renderSpecialists(specs, (args && args[0]) || '');
      if (out.html) addSystemMessageHTML(out.html);
      else addSystemMessage(out.text);
    }

    // /perms — the permission posture, and the log of what was let
    // through this session. The log is why the command exists: an
    // allow-session granted an hour ago is invisible everywhere else,
    // and since v1.10.0 (core-agent#830) the rows can name who granted
    // it.
    //
    // The attribution gate is the version rather than a flag, because
    // `by` is omitted on both sides of it — by a daemon too old to
    // record one, and by a current daemon that verified no identity for
    // the responder (an unauthenticated loopback listener, say). Only
    // the second is worth printing "unattributed" for; the first is a
    // backend that was never asked the question.
    async function cmdPerms() {
      let info;
      try {
        info = await client.getPerms();
      } catch (e) {
        addSystemMessage(describeError(e, '/perms failed: '));
        return;
      }
      const attribution =
        typeof client.protocolAtLeast === 'function' && client.protocolAtLeast('1.10.0');
      addSystemMessageHTML(window.SlashRender.renderPerms(info, { attribution: attribution }));
    }

    // /sessions — what else is on this backend. Read-only on purpose:
    // a terminal is handed a session id at construction and the shell
    // around it (a tab strip, a panel, a sidebar row) is what knows
    // that binding, so switching from in here would repoint the client
    // and leave the shell captioning the wrong session. The switch
    // gesture belongs to the sidebar; see #60.
    async function cmdSessions() {
      let rows;
      try {
        rows = await client.listSessions();
      } catch (e) {
        addSystemMessage(describeError(e, '/sessions failed: '));
        return;
      }
      session.setSessions(rows);
      if (!rows || rows.length === 0) {
        addSystemMessage('No sessions on this backend.');
        return;
      }
      // Most recently touched first — the operator's mental model, and
      // the order the sidebar and core-tui's picker both use. Rows with
      // no timestamp (older backends) sink.
      const sorted = rows
        .slice()
        .sort(
          (a, b) =>
            (b.lastTouchedAt ? Date.parse(b.lastTouchedAt) : 0) -
            (a.lastTouchedAt ? Date.parse(a.lastTouchedAt) : 0)
        );
      const here = sess().currentSession;
      renderList(`Sessions (${sorted.length})`, [
        {
          items: sorted.map((s) => {
            const tags = [];
            if (s.app) tags.push(s.app);
            if (s.status && s.status !== 'active') tags.push(s.status);
            if (s.id === here) tags.push('this panel');
            // A titled row shows the title and keeps the id underneath,
            // because the id is what every other command takes.
            return { name: s.title || s.id, tags, description: s.title ? s.id : '' };
          }),
        },
      ]);
    }

    // /share [viewer|contributor <identity>] | [revoke <identity>]
    // — who else may reach this session (v1.10.0 ACL, core-agent#797).
    //
    // ─── Why this is a command and not a sidebar dialog ──────────────
    //
    // v0.5 plan OQ 1 asked sidebar or palette, and named the sidebar as
    // the place per-session gestures live (delete is there). The answer
    // is the palette — meaning here, in the table every shell's palette
    // reads — and it is forced by the two facts the route carries:
    //
    //   1. The ACL is session-scoped, and the sidebar's client is not.
    //      One AttachClient per DAEMON does the listing; the session id
    //      belongs to the panel.
    //   2. The gate is the negotiated protocol version, and the version
    //      only exists in a `capabilities` frame — core-agent stamps
    //      X-Attach-Protocol-Version on /events and on nothing else
    //      (pkg/attach/protocol.go:95, the only caller). A sidebar row
    //      for a session nobody has opened has never seen one.
    //
    // So the sidebar would have to guess on both counts, and the plan
    // is explicit that guessing here means feature-detecting on a 404,
    // which for this route cannot be done: denial and "no such route"
    // are the same status by design. A panel has a bound session and a
    // negotiated version, so the gate is a fact rather than a guess.
    // One gesture, listed once, in both shells' palettes.
    //
    // The ownership rule falls out rather than being enforced twice:
    // both verbs are ActionSessionAdmin, so a session you do not own
    // 404s, and with the version already known that 404 has exactly one
    // remaining meaning — which is what the miss below says.
    //
    // Viewer and contributor stay different words, here and on the
    // wire. A viewer watches; a contributor writes into the session,
    // which is the escalation case the endpoint was filed for: a
    // watcher agent pages a human and the human's reply arrives under
    // their own identity and has to be allowed to land.
    const SHARE_ROLES = { viewer: 'viewers', contributor: 'contributors' };

    const SHARE_USAGE =
      '/share to see who it is shared with, ' +
      '/share viewer <identity> or /share contributor <identity> to grant, ' +
      '/share revoke <identity> to take it back.';

    function shareMiss(e, prefix) {
      // 404 is the ACL's denial as well as its absence, but the command
      // is version-gated, so the absence is already ruled out: what is
      // left is a session this caller does not administer (or one that
      // has just been deleted). Saying that is the whole value of
      // having gated on the version rather than on a probe.
      if (e && e.status === 404) {
        return (
          'Only the owner can see or change who a session is shared with — ' +
          'this one is not yours, or it is gone.'
        );
      }
      return describeError(e, prefix);
    }

    function renderACL(acl, note) {
      const me = (sess().whoami || {}).identity || '';
      const list = (names) =>
        (names || []).map((n) => ({ name: n, tags: n && n === me ? ['you'] : [] }));
      const viewers = (acl && acl.viewers) || [];
      const contributors = (acl && acl.contributors) || [];
      const owner = (acl && acl.owner) || '(unreported)';
      renderList(
        'Shared: ' + (sess().currentSession || 'this session'),
        [
          { header: `Viewers (${viewers.length})`, items: list(viewers) },
          { header: `Contributors (${contributors.length})`, items: list(contributors) },
        ],
        {
          summary:
            'owner ' +
            owner +
            (owner === me ? ' (you)' : '') +
            ' · viewers watch, contributors can also send turns' +
            (note ? ' · ' + note : ''),
        }
      );
    }

    async function cmdShare(args) {
      const verb = (args[0] || '').toLowerCase();
      // An identity is one token, but a paste with a stray space should
      // not become "no identity given" — join and trim rather than
      // reading args[1] and ignoring the rest.
      const who = args.slice(1).join(' ').trim();

      if (!verb) {
        try {
          renderACL(await client.getACL());
        } catch (e) {
          addSystemMessage(shareMiss(e, '/share failed: '));
        }
        return;
      }
      const revoking = verb === 'revoke';
      if (!revoking && !SHARE_ROLES[verb]) {
        addSystemMessage('Unknown /share verb "' + verb + '". ' + SHARE_USAGE);
        return;
      }
      if (!who) {
        addSystemMessage('Who? /share ' + verb + ' <identity>');
        return;
      }

      // Read-modify-write, and only the lists that actually change go
      // in the PATCH: the fields are pointers upstream so an omitted
      // one is left alone and `[]` clears it, and sending a list we did
      // not touch would hand a stale snapshot back to the server — to
      // an authorization decision, which is the worst place to lose a
      // concurrent edit.
      let acl;
      try {
        acl = await client.getACL();
      } catch (e) {
        addSystemMessage(shareMiss(e, '/share failed: '));
        return;
      }
      if (who === (acl && acl.owner)) {
        addSystemMessage('The owner already has every grant, and cannot be demoted or removed.');
        return;
      }

      const before = {
        viewers: ((acl && acl.viewers) || []).slice(),
        contributors: ((acl && acl.contributors) || []).slice(),
      };
      const after = {
        viewers: before.viewers.filter((n) => n !== who),
        contributors: before.contributors.filter((n) => n !== who),
      };
      // A grant is a grant, not a second one: moving somebody from
      // viewer to contributor takes them out of the list they were in.
      // Both lists satisfy Read upstream, so an identity in both is a
      // display that says two things about one permission.
      if (!revoking) after[SHARE_ROLES[verb]].push(who);

      const patch = {};
      const changed = [];
      ['viewers', 'contributors'].forEach((k) => {
        if (before[k].length === after[k].length && before[k].every((n, i) => n === after[k][i])) {
          return;
        }
        patch[k] = after[k];
        changed.push(k);
      });
      if (changed.length === 0) {
        addSystemMessage(
          revoking
            ? who + ' was not on the ACL — nothing to revoke.'
            : who + ' is already a ' + verb + '.'
        );
        return;
      }

      try {
        // Render the echo, not what we sent: the 200 answers with what
        // was stored.
        renderACL(
          await client.patchACL(patch),
          revoking ? 'revoked ' + who : who + ' is now a ' + verb
        );
      } catch (e) {
        addSystemMessage(shareMiss(e, '/share failed: '));
      }
    }

    // /model — what this session is running. Read-only because there is
    // nothing to write to: verified again 2026-09-12, core-agent has no
    // model-switch endpoint (pkg/attach/handlers_operator.go), and the
    // current model is server-driven via status-update. app.js shipped
    // a `/model <name>` that could only ever throw; saying so up front
    // is the honest version of the same non-capability.
    //
    // It also answers who is running it. `capabilities.agent` (protocol
    // §2.1) names the agent, its version and the model/provider it is
    // configured with; the classic shell painted that into a sidebar
    // slot, and a terminal has no sidebar slot. /model is the question
    // it belongs to — the model is the agent's, not the session's — so
    // retiring index.html moves the field here rather than dropping it.
    function cmdModel() {
      const model = sess().currentModel;
      const agent = (sess().capabilities || {}).agent;
      const lines = [];
      if (agent && typeof agent === 'object' && agent.name) {
        const via = [agent.model, agent.provider ? 'via ' + agent.provider : '']
          .filter(Boolean)
          .join(' ');
        lines.push(
          'Agent: ' +
            [agent.name, agent.version].filter(Boolean).join(' ') +
            (via ? ' (' + via + ')' : '')
        );
        if (agent.description) lines.push(agent.description);
      }
      lines.push(
        model ? 'Model: ' + model : 'The backend has not reported a model for this session yet.'
      );
      lines.push('Switching models needs a server-side endpoint that does not exist yet.');
      addSystemMessage(lines.join('\n'));
    }

    // /guardrails [reset [watchdog|cost_ceiling|all] [budget]]
    // — the watchdog and cost-ceiling trip state, and the operator
    // reset for them (core-agent#670/#671). Gated on features.
    // guardrails, which is the one flag in this table that a real
    // backend actually turns off.
    async function cmdGuardrails(args) {
      if ((args[0] || '').toLowerCase() === 'reset') {
        const guardrail = args[1] || undefined;
        const budget = args[2] !== undefined ? Number(args[2]) : undefined;
        try {
          const r = await client.resetGuardrails({
            guardrail,
            additionalBudgetUsd: Number.isFinite(budget) ? budget : undefined,
          });
          if (r.ok) {
            // A tripped ceiling freezes the input; clearing the flag is
            // what makes the reset mean anything from in here.
            session.setCostCeilingHit(false);
            addSystemMessage(
              'Guardrails reset: ' +
                (r.reset && r.reset.length ? r.reset.join(', ') : '(nothing tripped)')
            );
          } else {
            // 409, not a failure: the reset would re-trip immediately.
            addSystemMessage(
              r.message ||
                'Reset would immediately re-trip — pass a budget: /guardrails reset cost_ceiling <usd>'
            );
          }
        } catch (e) {
          addSystemMessage(describeError(e, '/guardrails reset failed: '));
        }
        return;
      }
      try {
        addSystemMessage(window.SlashRender.formatGuardrails(await client.getGuardrails()));
      } catch (e) {
        addSystemMessage(describeError(e, '/guardrails failed: '));
      }
    }

    // /pause, /continue, /abandon — the hold's vocabulary (#70).
    //
    // core-tui's words, deliberately. "/resume" is the route's name and
    // the wrong name for a person: the thing an operator wants to say
    // at a held session is what happens next — carry on, or drop it —
    // and `/resume steer "…"` makes them spell a mode where typing the
    // correction would have done. So the modes are the commands, typing
    // is the third one, and the route keeps its own name in the client.
    async function cmdPause(args) {
      const reason = args.join(' ').trim();
      try {
        const r = (await client.pause(reason)) || {};
        // Idempotent: already-held is a 200 with transitioned:false,
        // and saying "held" again would imply this press did it.
        if (r.transitioned === false) {
          addSystemMessage('Already held. /continue, /abandon, or type a correction to steer.');
        } else {
          addSystemMessage(
            'Held. /continue to carry on, /abandon to drop the work, or type a correction to steer.'
          );
        }
        // Post-condition from the server, same argument as releaseHold:
        // this is the route reporting the gate it just closed, not us
        // assuming it closed. The `pause` frame will repeat it.
        if (r.paused) {
          // pause_reason / paused_since, not reason / since: this is
          // PauseResponse (core-agent pkg/attach/pause.go:104-107) and
          // its JSON tags are the prefixed ones. The `pause` FRAME uses
          // the short names, which is the mismatch worth naming here —
          // the two carry the same two facts under different keys.
          session.applyPauseEvent({
            state: 'paused',
            reason: r.pause_reason || reason,
            at: r.paused_since || null,
          });
          renderHold();
          refreshStatus();
        }
      } catch (e) {
        addSystemMessage(describeError(e, '/pause failed: '));
      }
    }

    // Both of these go to the server even when the store says the
    // session is not held. The route is idempotent and answers
    // `resumed: false`, which is the same sentence from the authority
    // rather than from our copy of its state — and our copy is exactly
    // what is stale in the case where it matters.
    function cmdContinue() {
      return releaseHold('continue');
    }

    function cmdAbandon() {
      return releaseHold('abandon');
    }

    // /export [json|md] — this panel's transcript, downloaded.
    //
    // Scraped from `out` rather than from a model of the conversation,
    // because there isn't one: the terminal renders frames as they
    // arrive and the DOM is the only record. Scoped to this panel's
    // container, which is the one improvement over app.js's version —
    // there, one global query meant a workspace could only export
    // whatever happened to be on screen.
    //
    // Server-side export of the full eventlog is still a separate,
    // unbuilt thing (it needs an attach endpoint over pkg/audit); this
    // is the rendered transcript and says so in the payload.
    function cmdExport(args) {
      const fmt = (args[0] || 'json').toLowerCase();
      if (fmt !== 'json' && fmt !== 'md') {
        addSystemMessage('Usage: /export [json|md]');
        return;
      }
      const rows = [];
      out.querySelectorAll('.message').forEach((el) => {
        const role = el.classList.contains('user')
          ? 'user'
          : el.classList.contains('assistant')
            ? 'assistant'
            : el.classList.contains('system')
              ? 'system'
              : 'unknown';
        // Prefer the markdown source an assistant row stashed; the
        // rendered DOM has lost the fences by the time we get here.
        const text = el.dataset && el.dataset.source ? el.dataset.source : el.textContent;
        rows.push({ role, text: (text || '').trim() });
      });
      const s = sess();
      const payload = {
        exportedAt: new Date().toISOString(),
        endpoint: s.endpoint,
        sessionId: s.currentSession || null,
        turns: s.turnCount,
        totalCostUSD: s.totalCostUSD,
        source: 'rendered-transcript',
        messages: rows,
      };
      const body =
        fmt === 'md'
          ? [
              '# mast session export',
              '',
              `- Session: \`${s.currentSession || '(none)'}\``,
              `- Endpoint: ${s.endpoint}`,
              `- Turns: ${s.turnCount}`,
              `- Cost: $${s.totalCostUSD.toFixed(6)}`,
              `- Exported: ${payload.exportedAt}`,
              '',
              '---',
              '',
              ...rows.map((r) => `**${r.role}:**\n\n${r.text}\n`),
            ].join('\n')
          : JSON.stringify(payload, null, 2);
      const blob = new Blob([body], {
        type: fmt === 'md' ? 'text/markdown' : 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mast-session-${s.currentSession || 'panel'}.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
      addSystemMessage(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} as ${fmt}.`);
    }

    // /clear — display-only, which is why it runs offline. Everything
    // else in this table needs a backend to answer it; clearing a panel
    // should still work on a dead one.
    function cmdClear() {
      out.replaceChildren();
      // The history block went with it; forget the handles so a stray
      // scroll doesn't hand turns to a detached container.
      replayView.el = null;
      replayView.body = null;
      replayView.more = null;
      out.removeEventListener('scroll', onHistoryScroll);
      // The observer notice is not transcript — it is a standing fact
      // about the session, and clearing the screen does not make you
      // the one driving it. Redrawn rather than kept, since the node
      // just left the document.
      ui.observerBanner = null;
      applyObserverMode((sess().capabilities || {}).features);
    }

    function cmdHelp() {
      const rows = COMMANDS.filter(available);
      const width = rows.reduce((w, b) => Math.max(w, b.usage.length), 0);
      const describe = (b) => b.usage.padEnd(width) + '  — ' + b.help;
      const lines = rows.filter((b) => !b.shell).map(describe);
      // The shell's commands are listed apart because they answer a
      // different question: /clear is about this panel, /layout is about
      // every panel on the page. Same table, same gate, two headings.
      const shellRows = rows.filter((b) => b.shell);
      if (shellRows.length) {
        lines.push('', 'This shell:');
        shellRows.forEach((b) => lines.push(describe(b)));
      }
      const advertised = advertisedNames();
      if (advertised.length) {
        lines.push('', 'Advertised by this agent:');
        advertised.forEach((n) => lines.push('/' + n));
      } else {
        lines.push('', 'This agent advertises no slash commands.');
      }
      const hidden = COMMANDS.filter((b) => !available(b)).map((b) => '/' + b.name);
      if (hidden.length) {
        lines.push('', 'Not supported by this backend: ' + hidden.join(', '));
      }
      addSystemMessage(lines.join('\n'));
    }

    // The table. `feature` names the capability flag a command needs;
    // `minVersion` the protocol version its route landed in, for the
    // routes nobody flagged; `offline` marks the ones that don't need a
    // backend at all; `midTurn` marks the ones that may be typed while
    // a turn is running; `aliases` are extra spellings that dispatch
    // but are not listed separately.
    //
    // Commands with no `feature` are ungated because there is nothing
    // to gate them on — `features` has no key for a tool catalog or an
    // identity lookup, and per §2.1's additive rule an absent key reads
    // as on anyway, so inventing one here would only be a guess with
    // extra steps. The endpoints answer or they error; that's the same
    // deal PR 2 shipped.
    const BUILTINS = [
      { name: 'help', usage: '/help', help: 'This list', offline: true, run: cmdHelp },
      { name: 'clear', usage: '/clear', help: 'Clear this panel', offline: true, run: cmdClear },
      {
        name: 'export',
        usage: '/export [json|md]',
        help: "Download this panel's transcript",
        offline: true,
        run: cmdExport,
      },
      {
        name: 'tools',
        usage: '/tools [source]',
        help: 'Tool catalog, grouped by source',
        run: cmdTools,
      },
      {
        name: 'mcp',
        usage: '/mcp',
        help: 'MCP servers and what each contributes',
        feature: 'mcp',
        run: cmdMcp,
      },
      {
        name: 'subagents',
        usage: '/subagents [events <name> | stop <name>]',
        help: 'Configured subagents; `events` to drill in, `stop` to halt one',
        run: cmdSubagents,
      },
      {
        name: 'perms',
        aliases: ['permissions'],
        usage: '/perms',
        help: 'Permission mode, patterns, and who approved what',
        run: cmdPerms,
      },
      {
        name: 'specialists',
        usage: '/specialists [name]',
        help: 'Spawnable specialists, with model, modes and tool grant',
        // core-agent's `specialists` flag means "can spawn one", not
        // "can list them" — a backend that reports false still answers
        // the catalog endpoint. Gated anyway: a roster of things this
        // backend will refuse to spawn is a menu of nothing. Noted as a
        // known imprecision in #45 rather than pretended away.
        feature: 'specialists',
        run: cmdSpecialists,
      },
      {
        name: 'sessions',
        usage: '/sessions',
        help: 'Sessions on this backend',
        feature: 'multi_session',
        run: cmdSessions,
      },
      {
        name: 'guardrails',
        usage: '/guardrails [reset ...]',
        help: 'Watchdog and cost-ceiling state; `reset` to clear a trip',
        feature: 'guardrails',
        run: cmdGuardrails,
      },
      // Both gates, and they catch different backends: `features.pause`
      // is a 1.5.0+ server whose agent implements no PauseController,
      // and the version is a server old enough to have no /pause route
      // at all — where the absent flag would otherwise read as on
      // (§2.1) and offer three commands that can only 404.
      {
        name: 'pause',
        usage: '/pause [reason]',
        help: 'Hold the loop — no new turn starts until it is released',
        feature: 'pause',
        minVersion: '1.5.0',
        midTurn: true,
        run: cmdPause,
      },
      {
        name: 'continue',
        aliases: ['cont'],
        usage: '/continue',
        help: 'Release a hold and carry on (alias /cont)',
        feature: 'pause',
        minVersion: '1.5.0',
        midTurn: true,
        run: cmdContinue,
      },
      {
        name: 'abandon',
        usage: '/abandon',
        help: 'Release a hold and drop the held work',
        feature: 'pause',
        minVersion: '1.5.0',
        midTurn: true,
        run: cmdAbandon,
      },
      {
        name: 'share',
        usage: '/share [viewer|contributor <identity> | revoke <identity>]',
        help: 'Who else may reach this session',
        // Version, not a feature flag: core-agent ships no `acl` key,
        // and the route's 404 covers both "old server" and "not yours"
        // so a probe answers nothing. See cmdShare.
        minVersion: '1.10.0',
        run: cmdShare,
      },
      { name: 'model', usage: '/model', help: 'Model this session is running', run: cmdModel },
      { name: 'usage', usage: '/usage', help: 'Session token + cost totals', run: cmdUsage },
      {
        name: 'whoami',
        usage: '/whoami',
        help: 'Backend identity for this caller',
        run: cmdWhoami,
      },
    ];

    // Built-ins plus the shell's contributions, which is the table
    // everything downstream reads: dispatch, /help, and the shell's own
    // command palette via api.commands.
    //
    // Every spelling the built-in table answers to, aliases included.
    // Its own list, on purpose. core-tui#289 derived "is this a
    // command" from a narrower set once, and /quit at a held session
    // went to the agent as prose — the command inverted into its own
    // subject at the exact moment it mattered most. A name this table
    // knows is a command everywhere it is asked.
    const BUILTIN_NAMES = new Set();
    BUILTINS.forEach((b) => {
      BUILTIN_NAMES.add(b.name);
      (b.aliases || []).forEach((a) => BUILTIN_NAMES.add(a));
    });

    // A shell cannot shadow a built-in. /clear means the same thing in
    // every panel of every shell, and a shell that could redefine it
    // would make that a per-page question.
    const COMMANDS = BUILTINS.concat(
      shellCommands
        .filter(function (c) {
          return (
            c &&
            typeof c.name === 'string' &&
            typeof c.run === 'function' &&
            !BUILTIN_NAMES.has(c.name.toLowerCase())
          );
        })
        .map(function (c) {
          return { ...c, name: c.name.toLowerCase(), shell: true };
        })
    );

    // The one read. /help filters on this and dispatch checks it, so a
    // command cannot be listed and then refuse, or refuse and then be
    // invisible — core-tui#275/#276.
    //
    // Absent `features` map, or absent key within it, means on: the
    // protocol's §2.1 additive rule, and the reason a 2026-02 backend
    // doesn't lose /mcp for never having heard of the flag.
    // `minVersion` is the third question and it fails the other way
    // round: an absent flag means on (a producer that predates the
    // flag still has the feature), but an absent or older version
    // means off (a producer that predates the route does not have it).
    // Both gates apply when a row carries both.
    function available(b) {
      const P = window.AttachCoreProtocol;
      if (b.minVersion && P && P.protocolAtLeast) {
        if (!P.protocolAtLeast(sess().capabilities, b.minVersion)) return false;
      }
      if (!b.feature) return true;
      return !P || !P.hasFeature ? true : P.hasFeature(sess().capabilities, b.feature);
    }

    function advertisedNames() {
      const caps = sess().capabilities;
      return (caps && caps.slash_commands) || [];
    }

    function findCommand(name) {
      return COMMANDS.find((b) => b.name === name || (b.aliases || []).includes(name));
    }

    // May this input run inside a turn? Read off the same table /help
    // and dispatch read, so a command cannot be mid-turn-legal in one
    // place and not the other — and gated, so a name this backend can't
    // serve doesn't become a hole in the busy guard.
    function isMidTurnCommand(trimmed) {
      const b = findCommand(trimmed.slice(1).split(/\s+/)[0].toLowerCase());
      return !!(b && b.midTurn && available(b));
    }

    // Returns true when the input was a command and has been handled.
    async function handleSlash(trimmed) {
      const parts = trimmed.slice(1).split(/\s+/);
      const raw = parts[0];
      // Built-ins are ours to spell, so they match case-insensitively.
      // An advertised name is the agent's, matched exactly — the server
      // routes on the string it published, and folding case here would
      // have us post /Compact to a backend that only answers /compact.
      const name = raw.toLowerCase();
      const args = parts.slice(1);

      // Built-ins win over an advertised name of the same spelling —
      // what app.js did, and what core-tui settled on. An agent that
      // advertises /tools gets shadowed rather than silently changing
      // what /tools means from one backend to the next.
      const builtin = findCommand(name);
      if (builtin) {
        // A gated-off command is a name we know and cannot serve, which
        // is a different answer from "unknown" and deserves a different
        // sentence. It isn't in /help either — same available() call.
        if (!available(builtin)) {
          addSystemMessage('/' + name + ' is not supported by this backend.');
          return true;
        }
        if (!builtin.offline && connection.getState() !== 'connected') {
          addSystemMessage('Not connected.');
          return true;
        }
        // Built-ins close over the transcript; a shell's command was
        // written somewhere else and is handed the two things it could
        // not otherwise reach — somewhere to answer, and the terminal
        // it was typed into.
        await builtin.run(args, builtin.shell ? { print: addSystemMessage, terminal: api } : null);
        return true;
      }
      if (advertisedNames().includes(raw)) {
        if (connection.getState() !== 'connected') {
          addSystemMessage('Not connected.');
          return true;
        }
        await runServerSlash(raw, args);
        return true;
      }
      addSystemMessage('Unknown command: /' + raw + '. Type /help for available commands.');
      return true;
    }

    // Resolves with the turn's measurements once it closes, or null
    // when there was no turn — a slash command, a dead connection, or
    // one already in flight. The batch runner is the caller that needs
    // this; the input wiring ignores it.
    async function submit(text) {
      const trimmed = (text || '').trim();
      if (!trimmed) return null;
      // Busy, and not one of the two things that are still allowed to
      // happen mid-turn: a `midTurn` command, or a steer at a session
      // somebody has held. "Stop and let me look" is worth nothing if
      // it only works once the thing you wanted to look at has ended.
      if (connection.isRunning() && !sess().pause.paused) {
        if (!trimmed.startsWith('/') || !isMidTurnCommand(trimmed)) return null;
      }
      // Commands answer for themselves on a dead connection: /clear and
      // /export are display actions that should still work on one, and
      // the rest say "Not connected." from the same table that decides
      // they needed a backend. A prompt has nowhere to go either way.
      if (trimmed.startsWith('/')) {
        input.value = '';
        syncInput();
        await handleSlash(trimmed);
        return null;
      }
      if (connection.getState() !== 'connected') {
        addSystemMessage('Not connected.');
        return null;
      }

      // Typing at a held session steers it. Note the order: the slash
      // branch above has already run, so a command at a held session is
      // still a command — it is not shipped to the agent as prose.
      //
      // The text is NOT run here. mast-web reads a standing stream, so
      // the host takes the correction, frames it as an interrupt-steer
      // (which is what tells the model its last turn was killed), and
      // the answer arrives on the stream we are already reading. Who
      // runs the steer depends on who owns the loop, and we don't;
      // running it here as well would send it twice. The transcript
      // still gets the operator's copy, because nothing else will draw
      // it — the echo is suppressed live.
      if (sess().pause.paused) {
        // Same reason the prompt path does it below: whatever is still
        // open belongs above this line, not under it.
        flushTurnClose();
        drawHistory();
        ui.lastUserPrompt = trimmed;
        addMessage('user', trimmed);
        await releaseHold('steer', trimmed);
        return null;
      }
      if (connection.isRunning()) return null;

      // A turn still inside its grace window (an observer one — an
      // operator turn holds the running flag until it closes) gets its footer
      // now, above this prompt rather than under it. Replayed history
      // settles for the same reason: it happened before this prompt,
      // and it is about to have live content underneath it.
      flushTurnClose();
      drawHistory();
      setRunning(true);
      ui.lastUserPrompt = trimmed;
      addMessage('user', trimmed);
      startElapsed();
      const thinking = startThinking();
      let streaming = null;
      const pendingToolEls = [];
      let searchEl = null;
      let sourcesEl = null;
      const seenSources = new Set();
      // Time to the first frame of any kind. turn-complete carries the
      // total but nothing carries this, and it is the number that says
      // whether the agent is thinking or the queue is full.
      const startedAt = performance.now();
      let firstFrameAt = 0;
      const mark = () => {
        if (!firstFrameAt) firstFrameAt = performance.now();
      };

      try {
        const result = await runPrompt(trimmed, {
          onToken(t) {
            mark();
            if (!streaming) {
              thinking.stop();
              streaming = createStreamingMessage();
            }
            updateStreamingMessage(streaming, t);
          },
          onToolCall(server, tool) {
            mark();
            streaming = null;
            pendingToolEls.push(addToolPendingMessage(server, tool));
          },
          onToolResult(server, tool, latencyMs, errMsg, resultJSON) {
            completeToolMessage(pendingToolEls.shift(), latencyMs, errMsg, resultJSON);
          },
          onGroundingQuery(query) {
            mark();
            thinking.stop();
            streaming = null;
            if (!searchEl) searchEl = addSearchQueryRow();
            appendSearchQuery(searchEl, query);
          },
          onGroundingSource(title, uri) {
            mark();
            thinking.stop();
            streaming = null;
            if (seenSources.has(uri)) return;
            seenSources.add(uri);
            if (!sourcesEl) sourcesEl = addSourcesStrip();
            appendSource(sourcesEl, title, uri);
          },
        });
        ui.lastFooter = addTurnFooter(result);
        if (!ui.serverCountsTurns) session.incrementTurnCount();
        updateStatus();
        return {
          ok: true,
          ...result,
          ttfbMs: firstFrameAt ? firstFrameAt - startedAt : result.totalMs,
        };
      } catch (e) {
        // Rendered into the transcript, which is where an operator will
        // look, and handed back for a caller that is driving a queue
        // rather than watching one. Deliberately not rethrown: every
        // other call site is a keypress with nobody to catch it.
        addSystemMessage(describeError(e));
        return { ok: false, error: describeError(e) };
      } finally {
        thinking.stop();
        stopElapsed();
        pendingToolEls.forEach((el) => completeToolMessage(el, 0, 'turn ended', ''));
        setRunning(false);
      }
    }

    async function stop() {
      if (!connection.isRunning()) return;
      stopBtn.disabled = true;
      try {
        const r = await client.interrupt();
        if (r && r.unsupported) addSystemMessage('This agent does not support interrupt.');
        // We asked for hold: false, so this should never fire. If it
        // does, the gate is closed and the operator is now one keypress
        // from a turn that will never start — so record the
        // post-condition the route just reported, which raises the
        // banner and with it the way out.
        if (r && r.paused) {
          session.applyPauseEvent({ state: 'paused', reason: 'held by the backend on interrupt' });
          renderHold();
          addSystemMessage(
            'Held — the agent will not start another turn. /continue to release it.'
          );
        }
      } catch (e) {
        addSystemMessage(describeError(e, 'Interrupt failed: '));
      } finally {
        stopBtn.disabled = false;
      }
    }

    // ── Input wiring ─────────────────────────────────────────────────

    function syncInput() {
      shell.classList.toggle('has-text', input.value.length > 0);
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }

    input.addEventListener('input', syncInput);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = input.value;
        input.value = '';
        syncInput();
        submit(text);
      }
      // Escape is the shell's ("send this panel back"), so let it
      // bubble — but drop the caret first, or the parked panel keeps
      // swallowing keystrokes meant for the camera.
      if (e.key === 'Escape') {
        input.blur();
        return;
      }
      // A chord with alt / ctrl / meta is never text input, so it
      // belongs to whichever shell is hosting this terminal — solo.html
      // binds alt+1…9 to its tab strip, and the prompt has focus
      // essentially always, so swallowing these would make the tab
      // strip unreachable from the keyboard. Shift is deliberately not
      // in the list: shift+arrow is selection.
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      // Every other bare key the spatial shell binds to the camera
      // (arrows, r, +/-) belongs to the text field while it has focus.
      e.stopPropagation();
    });
    sendBtn.addEventListener('click', () => {
      const text = input.value;
      input.value = '';
      syncInput();
      submit(text);
    });
    stopBtn.addEventListener('click', stop);

    // ── Public instance API ──────────────────────────────────────────

    const api = {
      el: root,
      out: out,
      client: client,
      // The two stores, for a shell that wants to observe rather than
      // poll. This is the whole point of the seam: a status bar can
      // subscribe to a terminal it does not own.
      session: session,
      connection: connection,

      // A flat snapshot in the field names the shells already use.
      // Reading it is a point-in-time copy — subscribe() is how you
      // find out that it changed.
      get state() {
        const s = sess();
        const c = connection.get();
        return {
          endpoint: s.endpoint,
          sessionId: s.currentSession,
          label: s.label,
          connState: c.state,
          // Is this agent working — not "did this browser press send".
          // Until 1.12.0 the two were the same question here, because
          // nothing else could answer: a mid-turn poll said "idle" and
          // the room's busy pulse went out on any session someone else
          // was driving (#93). The OR is the fix and the order is the
          // honesty: the local flag is certain and instant, the server's
          // three keys are the ones that see somebody else's turn.
          running: c.isRunning || serverRunning(s),
          // The local half on its own, for anything that means "this
          // browser has a turn out" — a shell should not have to
          // re-derive it from the pair below.
          driving: c.isRunning,
          model: s.currentModel,
          turns: s.turnCount,
          costUSD: s.totalCostUSD,
          capabilities: s.capabilities,
          // Resolved backend identity, or null while /whoami is in
          // flight or on a server too old to answer. Already rendered
          // for a HUD slot — a shell should not have to know that
          // proxy_by means "on behalf of".
          identity: s.whoami ? describeWhoami(s.whoami) : '',
          whoami: s.whoami,
          // The hold. The banner belongs to the panel — it is about one
          // session and it sits over that session's prompt — but "how
          // many of the six are parked" is a question only the window
          // can answer, and it is the one you need before you go
          // looking. So: the banner here, a count in the status bar
          // (#70 OQ2).
          paused: s.pause.paused,
          pauseReason: s.pause.reason,
          // The two halves of the pair, unfolded, for anything that
          // needs to tell them apart — the hold banner says "held, and
          // the turn it interrupted is still unwinding" and that
          // sentence has no single field behind it. Poll-only, and so
          // both read false on a backend older than 1.12.0 because the
          // keys were absent, not because nothing is running.
          turnInFlight: s.status.turnInFlight,
          runState: s.status.runState,
          turnState: s.status.turnState,
        };
      },

      // What this terminal will actually dispatch, right now, with the
      // capability gate already applied and the agent's advertised
      // names folded in. The shell's command palette reads this rather
      // than keeping a list of its own: a palette that offers a name
      // the prompt would refuse is the second read again (#45).
      get commands() {
        return COMMANDS.filter(available)
          .map((c) => ({
            name: c.name,
            usage: c.usage,
            help: c.help,
            source: c.shell ? 'shell' : 'builtin',
          }))
          .concat(
            advertisedNames().map((n) => ({
              name: n,
              usage: '/' + n,
              help: 'Advertised by this agent',
              source: 'agent',
            }))
          );
      },

      // Fires on any change to either store. Returns an unsubscribe.
      subscribe(fn) {
        const offS = session.subscribe(() => fn(api));
        const offC = connection.subscribe(() => fn(api));
        return function () {
          offS();
          offC();
        };
      },

      async connect() {
        try {
          if (!sess().currentSession) {
            const s = await client.autoSelectSession();
            session.setCurrentSession(s.id);
            if (!sess().label) session.setLabel(s.id);
            setPrefix();
          }
          await client.connect();
          openPromptStream();
          addMessage(
            'system',
            'attached · ' + endpoint + ' · session ' + sess().currentSession,
            'cmd-output'
          );
        } catch (e) {
          setConnState('disconnected');
          addSystemMessage(describeError(e, 'Attach failed: '));
          throw e;
        }
      },

      submit: submit,
      stop: stop,

      // Read GET /status now rather than waiting for the cadence, and
      // re-arm the chain behind it. For a shell with a tab that has
      // just come to the front, and for a test that would rather not
      // wait ten seconds to see the poll work. Resolves to the body, or
      // to null if the read was skipped or refused.
      refreshStatus: refreshStatus,

      // Drops text into the prompt and puts the caret after it, without
      // sending. What the command palette wants: picking /tools from a
      // list should leave you able to type ` builtin` after it, not
      // commit you to the bare command.
      prefill(text) {
        input.value = text || '';
        syncInput();
        api.focusInput();
        input.selectionStart = input.selectionEnd = input.value.length;
      },

      focusInput() {
        // preventScroll: the prompt sits inside a 3D-transformed panel
        // whose border box can land outside the window, and the default
        // focus behaviour would scroll the page to "reveal" it — which
        // in the spatial shell means scrolling the HUD off the top.
        input.focus({ preventScroll: true });
      },

      // Called by the shell when this terminal becomes the centered
      // one; a panel-sized transcript needs re-pinning to the bottom
      // after the resize transition settles.
      reflow() {
        scroll();
      },

      destroy() {
        if (ui.destroyed) return;
        ui.destroyed = true;
        // Nothing else is coming; settle the turn and abandon any
        // undrawn history rather than leaving timers pointed at a
        // detached transcript.
        flushTurnClose();
        replayView.sealed = true;
        clearTimeout(replayView.timer);
        clearTimeout(statusTimer);
        statusTimer = 0;
        stopElapsed();
        closePromptStream();
        try {
          client.disconnect();
        } catch {
          /* best effort */
        }
        root.remove();
      },
    };

    setConnState('disconnected');
    updateStatus();
    renderHold();
    renderRunning();
    syncInput();
    return api;
  }

  return { create: create };
})();
