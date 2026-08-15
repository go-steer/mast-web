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
// It is deliberately a subset. Dropped, because they're workspace-level
// concerns or don't fit in a 400px panel: the batch runner, all five
// modals (setup / perms / shortcuts / palette / picker), client-side
// slash commands, citation pills, the model picker, subagent and
// guardrail drill-downs, session export, and the sidebar. Kept, because
// they're what a terminal *is*: streaming markdown, tool-call rows with
// click-to-expand results, turn footers, the thinking indicator,
// interrupt, and observer-mode rendering of externally-driven turns.
//
// Requires (load order): marked + marked-highlight + highlight.js from
// CDN, then attach-core/{errors,protocol,replay,client}.js.
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
      destroyed: false,
    };

    const pendingToolCallsByID = new Map();
    let activeTurn = null;
    let elapsedTimer = null;

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

    function addTurnFooter(result) {
      const div = mk('div', 'turn-footer');
      div.dataset.totalMs = String(result.totalMs || 0);
      div.dataset.tokensIn = String(result.tokens.in || 0);
      div.dataset.tokensOut = String(result.tokens.out || 0);
      div.dataset.costUsd = String(result.costUSD || 0);
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

    // turn-complete.cost_usd is v1.1.0-optional; the authoritative
    // number arrives later on usage-update.last_turn.
    function backfillTurnFooter(el, costUSD) {
      if (!el || typeof costUSD !== 'number' || costUSD <= 0) return;
      if ((Number(el.dataset.costUsd) || 0) === costUSD) return;
      el.dataset.costUsd = String(costUSD);
      renderTurnFooter(el);
    }

    function addBuiltinToolMessage(label, items) {
      items.forEach((item) => {
        const div = mk('div', 'message builtin-tool');
        div.appendChild(mk('span', 'tool-ts', '[' + nowStamp() + ']'));
        div.appendChild(mk('span', 'builtin-tool-label', label));
        div.appendChild(mk('code', '', item));
        out.appendChild(div);
      });
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
          onSearchQueries(q) {
            streaming = null;
            addBuiltinToolMessage('🔍 Search', Array.from(q));
          },
          onURLFetch(u) {
            streaming = null;
            addBuiltinToolMessage('🌐 URL fetched', Array.from(u));
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
            backfillTurnFooter(st.lastFooter, u.last_turn.cost_usd || 0);
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
        Promise.resolve()
          .then(() => client.inject(text))
          .then(() => client.wake())
          .catch((e) => turn.finish(null, e));
      });
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

      setRunning(true);
      st.lastUserPrompt = trimmed;
      addMessage('user', trimmed);
      startElapsed();
      const thinking = startThinking();
      let streaming = null;
      const pendingToolEls = [];

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
          onSearchQueries(q) {
            streaming = null;
            addBuiltinToolMessage('🔍 Search', Array.from(q));
          },
          onURLFetch(u) {
            streaming = null;
            addBuiltinToolMessage('🌐 URL fetched', Array.from(u));
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
