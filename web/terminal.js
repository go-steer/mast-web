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
// index.html's app.js is a singleton: one AttachClient, one
// #output-area, one prompt, one status bar, all reached through
// module-scope constants. That's the right shape for a single-session
// SPA and the wrong shape for a workspace where four sessions are on
// screen at once.
//
// This is the same terminal with the singleton assumption removed.
// Every renderer that app.js resolves against `outputArea` resolves
// here against a per-instance element, and every piece of turn state
// (activeTurn, lastUserPrompt, usage totals, pending tool calls) lives
// in the instance closure instead of module scope.
//
// What's here today: streaming markdown, tool-call rows with
// click-to-expand results, turn footers, the thinking indicator,
// interrupt, inline permission prompts, server-dispatched slash
// commands, grounded-source strips, and observer-mode rendering of
// externally-driven turns.
//
// What isn't here yet, and should be: the client-side slash commands
// app.js carries on top of the generic dispatch (/attach, /sessions,
// /model, …), the model picker, subagent and guardrail drill-downs,
// session export, and the batch runner. These are unported, not
// excluded. Parity with app.js is the target; a terminal in a panel
// should not be a lesser terminal than one in a tab, and where a
// feature needs a different presentation to fit the panel, that's a
// design problem to solve rather than a reason to drop it.
//
// Genuinely not this file's job, because they belong to the shell
// around the terminals rather than to any one of them: the sidebar and
// the setup / shortcuts / palette / picker modals. spatial.js owns
// those, the same way app.js does for the classic shell.
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

  function nowStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
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

    // Everything app.js keeps in module scope lives here instead, one
    // copy per terminal.
    const st = {
      endpoint: endpoint,
      sessionId: cfg.sessionId || '',
      label: cfg.label || cfg.sessionId || endpoint,
      connState: 'disconnected',
      running: false,
      lastUserPrompt: '',
      model: '',
      turns: 0,
      costUSD: 0,
      lastFooter: null,
      // Most recent usage-update.last_turn, held until a footer claims
      // it: core-agent emits usage-update *before* turn-complete, so
      // the priced-out cost arrives while the turn that earned it has
      // no footer yet, and lastFooter still points at the turn before.
      pendingLastTurn: null,
      destroyed: false,
    };

    const pendingToolCallsByID = new Map();
    let activeTurn = null;
    let elapsedTimer = null;
    let prompter = null;

    // ── DOM ──────────────────────────────────────────────────────────

    const root = mk('div', 'term');

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

    const statusRow = mk('div', 'term-status');
    const sConn = mk('span', 'term-stat term-conn', '⬤ disconnected');
    const sModel = mk('span', 'term-stat', '—');
    const sTurns = mk('span', 'term-stat', 'T0');
    const sCost = mk('span', 'term-stat', '$0.00');
    const sElapsed = mk('span', 'term-stat term-elapsed', 't+ —');
    statusRow.append(sConn, sModel, sTurns, sCost, sElapsed);

    root.append(screen, inputRow, statusRow);
    setPrefix();

    // ── Rendering (ported from app.js, bound to `out`) ───────────────

    function scroll() {
      out.scrollTop = out.scrollHeight;
    }

    function makeMsgHead(role) {
      const head = mk('div', 'msg-head');
      head.appendChild(mk('span', 'msg-role', role + ':'));
      head.appendChild(mk('span', 'msg-time', '[' + nowStamp() + ']'));
      return head;
    }

    function addMessage(role, content, extraClass) {
      const div = mk('div', 'message ' + role + (extraClass ? ' ' + extraClass : ''));
      if (role === 'assistant') {
        div.appendChild(makeMsgHead('AGENT'));
        const md = mk('div', 'md-content');
        md.innerHTML = renderMarkdown(content);
        div.appendChild(md);
        addMessageActions(div, content);
      } else if (role === 'user') {
        div.appendChild(makeMsgHead('USER'));
        div.appendChild(mk('div', 'msg-body', content));
      } else {
        div.dataset.ts = nowStamp();
        div.textContent = content;
      }
      out.appendChild(div);
      scroll();
      return div;
    }

    // `getText` is a thunk because a streaming row's final text isn't
    // known when the chips are attached.
    function addMessageActions(el, textOrGetter) {
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

      const retry = mk('button', 'msg-action', 'RETRY');
      retry.type = 'button';
      retry.title = 'Re-send the prompt that produced this response';
      retry.addEventListener('click', () => {
        if (!st.lastUserPrompt || st.running) return;
        submit(st.lastUserPrompt);
      });

      row.append(copy, retry);
      el.appendChild(row);
    }

    function addSystemMessage(text) {
      return addMessage('system', text, '');
    }

    // Slash output arrives as HTML from SlashRender, which escapes every
    // interpolated value itself — see slash-render.js's escapeHTML.
    function addSystemMessageHTML(html) {
      const div = mk('div', 'message system cmd-output');
      div.dataset.ts = nowStamp();
      div.innerHTML = html;
      out.appendChild(div);
      scroll();
      return div;
    }

    // ── Permission prompts ───────────────────────────────────────────
    //
    // app.js answers these in a global modal. A workspace can't reuse
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
      head.appendChild(mk('span', 'msg-time', '[' + nowStamp() + ']'));
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

      out.appendChild(div);
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
      if (!prompter) return;
      try {
        await prompter.respond(frame.id, decision);
      } catch (e) {
        addSystemMessage(describeError(e, 'perms respond failed: '));
      }
    }

    // The perms stream is a SECOND EventSource, opened alongside the
    // main one and torn down with the terminal.
    function openPromptStream() {
      closePromptStream();
      const Prompter = window.AttachCorePrompter && window.AttachCorePrompter.Prompter;
      if (!Prompter) return;
      prompter = new Prompter({
        endpoint: endpoint,
        token: token,
        sessionId: st.sessionId,
        onPrompt: (frame) => {
          if (st.destroyed || !frame || !frame.id) return;
          addPermsRequest(frame);
        },
        onTerminal: () => {
          if (st.destroyed) return;
          addSystemMessage(
            'Perms stream unavailable — this agent does not support interactive prompts, or the stream permanently failed.'
          );
        },
      });
      prompter.connect();
    }

    function closePromptStream() {
      if (!prompter) return;
      try {
        prompter.disconnect();
      } catch {
        /* best effort */
      }
      prompter = null;
    }

    function addTurnFooter(result) {
      const div = mk('div', 'turn-footer');
      const tokensIn = result.tokens.in || 0;
      const tokensOut = result.tokens.out || 0;
      let cost = result.costUSD || 0;
      // turn-complete.cost_usd is optional and core-agent omits it, so
      // the number usually arrives on usage-update.last_turn — ahead of
      // this footer existing. See st.pendingLastTurn.
      if (cost <= 0 && lastTurnMatches(st.pendingLastTurn, tokensIn, tokensOut)) {
        cost = st.pendingLastTurn.costUSD;
        st.pendingLastTurn = null;
      }
      div.dataset.totalMs = String(result.totalMs || 0);
      div.dataset.tokensIn = String(tokensIn);
      div.dataset.tokensOut = String(tokensOut);
      div.dataset.costUsd = String(cost);
      renderTurnFooter(div);
      out.appendChild(div);
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
      div.appendChild(mk('span', 'tool-ts', '[' + nowStamp() + ']'));
      div.appendChild(mk('span', 'builtin-tool-label', '🔍 Search'));
      div.appendChild(mk('code', '', ''));
      out.appendChild(div);
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
      out.appendChild(div);
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
        nowStamp() +
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
      out.appendChild(div);
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

    function createStreamingMessage() {
      const div = mk('div', 'message assistant');
      div.appendChild(makeMsgHead('AGENT'));
      const md = mk('div', 'md-content');
      div.appendChild(md);
      out.appendChild(div);
      const ref = { el: div, md: md, text: '' };
      addMessageActions(div, () => ref.text);
      return ref;
    }

    function updateStreamingMessage(msg, tokenText) {
      msg.text += tokenText;
      msg.md.innerHTML = renderMarkdown(msg.text);
      scroll();
    }

    function startThinking() {
      const el = mk('div', 'thinking');
      const pick = () => THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
      el.textContent = pick();
      out.appendChild(el);
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
      const sid = st.sessionId || 'mast';
      prefix.textContent = '[' + sid.slice(0, 12) + '] ~>';
    }

    function setConnState(state) {
      st.connState = state;
      const glyph = state === 'connected' ? '⬤' : state === 'connecting' ? '◐' : '○';
      sConn.textContent = glyph + ' ' + state;
      sConn.dataset.state = state;
      root.dataset.conn = state;
      onChange(api, 'conn');
    }

    function setRunning(running) {
      st.running = running;
      sendBtn.disabled = running;
      stopBtn.hidden = !running;
      root.classList.toggle('term-busy', running);
      onChange(api, 'busy');
    }

    function updateStatus() {
      sModel.textContent = st.model || '—';
      sTurns.textContent = 'T' + st.turns;
      sCost.textContent = '$' + st.costUSD.toFixed(st.costUSD < 1 ? 4 : 2);
    }

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
          activeTurn = null;
          root.classList.remove('term-observing');
          if (result) {
            st.lastFooter = addTurnFooter(result);
            st.turns += 1;
            updateStatus();
          }
          pendingToolEls.forEach((el) => completeToolMessage(el, 0, 'turn ended', ''));
        },
      };
      activeTurn = turn;
      return turn;
    }

    function dispatch(ev) {
      // Session-generation gate: attach-core bumps sessionGen on every
      // connect()/selectSession() and tags emitted events with the gen
      // at emit time, so stragglers from a prior stream drop here.
      if (client && typeof ev.gen === 'number' && ev.gen !== client.sessionGen) return;

      switch (ev.type) {
        case 'capabilities':
          st.capabilities = ev.data;
          return;

        case 'status-update': {
          const s = ev.data || {};
          if (s.model) {
            st.model = s.model;
            updateStatus();
          }
          return;
        }

        case 'usage-update': {
          const u = ev.data || {};
          if (typeof u.cost_usd_total === 'number') st.costUSD = u.cost_usd_total;
          if (typeof u.turns_total === 'number') st.turns = u.turns_total;
          if (u.last_turn && typeof u.last_turn === 'object') {
            const lt = {
              tokensIn: u.last_turn.tokens_in || 0,
              tokensOut: u.last_turn.tokens_out || 0,
              costUSD: u.last_turn.cost_usd || 0,
            };
            // Either ordering is legal on the wire: back-fill the
            // footer if it already exists, otherwise hold the payload
            // for addTurnFooter to claim.
            st.pendingLastTurn = lt;
            backfillTurnFooter(st.lastFooter, lt);
          }
          updateStatus();
          onChange(api, 'usage');
          return;
        }

        case 'turn-complete': {
          const tc = ev.data || {};
          if (activeTurn) {
            activeTurn.finish({
              totalMs: tc.latency_ms || performance.now() - activeTurn.startedAt,
              tokens: { in: tc.tokens_in || 0, out: tc.tokens_out || 0 },
              costUSD: typeof tc.cost_usd === 'number' ? tc.cost_usd : 0,
              toolCalls: [],
            });
          }
          return;
        }

        case 'turn-error': {
          const te = ev.data || {};
          const msg = `${te.kind || 'error'}: ${te.message || ''}${te.hint ? ' (' + te.hint + ')' : ''}`;
          if (te.kind === 'cost_ceiling') {
            addSystemMessage('Cost ceiling reached — session paused until /guardrails reset.');
          }
          if (activeTurn) activeTurn.finish(null, new Error(msg));
          else addSystemMessage('Turn error: ' + msg);
          return;
        }

        case 'stream-chunk': {
          if (ev.replay) return; // replay flood, not this view's history
          // Suppress the prompt echo, same as app.js: a real backend
          // replays the prompt the model received as a user-authored
          // frame ahead of the reply — [Inbox] wrapper and all — so
          // rendering it puts the operator's own message inside the
          // agent bubble. submit() has already drawn the real one.
          if (ev.data.author === 'user') return;
          // Grounding evidence, same reasoning: fanoutAgentFrame keeps
          // the wire decomposition faithful and the renderer decides
          // that a search query is a chip and a grounded source is a
          // pill on a sources strip, not body text. Fixture 007 pins
          // the shape.
          if (ev.data.author === GROUNDING_AUTHOR) {
            const line = parseGroundingLine(ev.data.text);
            if (line) {
              const gTurn = activeTurn || beginObserverTurn();
              if (line.query !== undefined) {
                if (gTurn.callbacks.onGroundingQuery) gTurn.callbacks.onGroundingQuery(line.query);
              } else if (gTurn.callbacks.onGroundingSource) {
                gTurn.callbacks.onGroundingSource(line.title, line.uri);
              }
              return;
            }
            // Unrecognized shape — fall through and render it as text.
          }
          const turn = activeTurn || beginObserverTurn();
          if (turn.callbacks.onToken) turn.callbacks.onToken(ev.data.text);
          return;
        }

        case 'tool-call': {
          if (ev.replay) return;
          const turn = activeTurn || beginObserverTurn();
          const { id, name } = ev.data;
          const idx = name.indexOf('_');
          const server = idx > 0 ? name.substring(0, idx) : '';
          const tool = idx > 0 ? name.substring(idx + 1) : name;
          if (turn.callbacks.onToolCall) turn.callbacks.onToolCall(server, tool);
          if (id) pendingToolCallsByID.set(id, { server, tool });
          return;
        }

        case 'tool-result': {
          if (ev.replay) return;
          if (!activeTurn || !activeTurn.callbacks.onToolResult) return;
          const { id, name, response, latencyMs } = ev.data;
          const idx = (name || '').indexOf('_');
          const server = idx > 0 ? name.substring(0, idx) : '';
          const tool = idx > 0 ? name.substring(idx + 1) : name;
          activeTurn.callbacks.onToolResult(
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
      sessionId: st.sessionId,
      onConnectionState: setConnState,
      onEvent: dispatch,
    });

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
            activeTurn = null;
            if (err) reject(err);
            else resolve(result);
          },
        };
        activeTurn = turn;
        // /inject only, no wake — see app.js's copy of this for the
        // measurement showing any second wake runs a second turn.
        Promise.resolve()
          .then(() => client.inject(text))
          .catch((e) => turn.finish(null, e));
      });
    }

    // ── Slash commands ───────────────────────────────────────────────
    //
    // Only the generic path: whatever the agent advertises in its
    // capabilities frame is POSTed to /sessions/{sid}/slash/<name> and
    // rendered through SlashRender. app.js additionally carries bespoke
    // client-side handlers (/attach, /sessions, /model, …); those are
    // still to port, and the workspace-scoped ones among them belong to
    // the HUD rather than to any one panel.
    //
    // What this replaces is worse than a missing feature: a leading "/"
    // used to fall through to client.inject(), so typing /tools sent the
    // literal string to the model as chat.

    async function runServerSlash(name, args) {
      const body = args.length > 0 ? { args: args.join(' ') } : {};
      const path =
        '/sessions/' + encodeURIComponent(st.sessionId) + '/slash/' + encodeURIComponent(name);
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

    // Returns true when the input was a command and has been handled.
    async function handleSlash(trimmed) {
      const parts = trimmed.slice(1).split(/\s+/);
      const name = parts[0];
      const args = parts.slice(1);
      const advertised = (st.capabilities && st.capabilities.slash_commands) || [];

      if (name === 'help') {
        const lines = ['/clear             — Clear this panel', '/help              — This list'];
        if (advertised.length) {
          lines.push('', 'Advertised by this agent:');
          advertised.forEach((n) => lines.push('/' + n));
        } else {
          lines.push('', 'This agent advertises no slash commands.');
        }
        addSystemMessage(lines.join('\n'));
        return true;
      }
      if (advertised.includes(name)) {
        await runServerSlash(name, args);
        return true;
      }
      addSystemMessage('Unknown command: /' + name + '. Type /help for available commands.');
      return true;
    }

    async function submit(text) {
      const trimmed = (text || '').trim();
      if (!trimmed || st.running) return;
      // The only client-side command that survives the minification:
      // clearing a panel is a display action, not a backend one.
      if (trimmed === '/clear') {
        out.replaceChildren();
        input.value = '';
        syncInput();
        return;
      }
      if (st.connState !== 'connected') {
        addSystemMessage('Not connected.');
        return;
      }
      if (trimmed.startsWith('/')) {
        input.value = '';
        syncInput();
        await handleSlash(trimmed);
        return;
      }

      setRunning(true);
      st.lastUserPrompt = trimmed;
      addMessage('user', trimmed);
      startElapsed();
      const thinking = startThinking();
      let streaming = null;
      const pendingToolEls = [];
      let searchEl = null;
      let sourcesEl = null;
      const seenSources = new Set();

      try {
        const result = await runPrompt(trimmed, {
          onToken(t) {
            if (!streaming) {
              thinking.stop();
              streaming = createStreamingMessage();
            }
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
            thinking.stop();
            streaming = null;
            if (!searchEl) searchEl = addSearchQueryRow();
            appendSearchQuery(searchEl, query);
          },
          onGroundingSource(title, uri) {
            thinking.stop();
            streaming = null;
            if (seenSources.has(uri)) return;
            seenSources.add(uri);
            if (!sourcesEl) sourcesEl = addSourcesStrip();
            appendSource(sourcesEl, title, uri);
          },
        });
        st.lastFooter = addTurnFooter(result);
        st.turns += 1;
        updateStatus();
      } catch (e) {
        addSystemMessage(describeError(e));
      } finally {
        thinking.stop();
        stopElapsed();
        pendingToolEls.forEach((el) => completeToolMessage(el, 0, 'turn ended', ''));
        setRunning(false);
      }
    }

    async function stop() {
      if (!st.running) return;
      stopBtn.disabled = true;
      try {
        const r = await client.interrupt();
        if (r && r.unsupported) addSystemMessage('This agent does not support interrupt.');
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
      state: st,
      client: client,

      async connect() {
        try {
          if (!st.sessionId) {
            const s = await client.autoSelectSession();
            st.sessionId = s.id;
            st.label = st.label || s.id;
            setPrefix();
          }
          await client.connect();
          openPromptStream();
          addMessage(
            'system',
            'attached · ' + endpoint + ' · session ' + st.sessionId,
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
        if (st.destroyed) return;
        st.destroyed = true;
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
    syncInput();
    return api;
  }

  return { create: create };
})();
