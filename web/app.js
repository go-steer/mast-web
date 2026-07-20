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

// mast-web — operator-facing web UI for mast / core-agent's attach
// protocol. Owns the rendering surface (chat, tool calls, sidebar,
// status bar, slash commands, batch run) and the per-turn dispatch
// from SSE events back into the rendering callbacks.
//
// The backend is reached via web/attach-client.js (loaded as a
// <script> sibling). The `mast` object below wraps an AttachClient
// instance and exposes the method surface app.js uses internally
// (init / listSessions / runPrompt / etc).
//
// Rendering pipeline ported from mastersingh24/cogo-wasm2 with
// cosmetic adaptations. See docs/web-design.md for the architectural
// rationale.

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────

  let connected = false;
  let turnCount = 0;
  let totalCostUSD = 0;
  let currentModel = '';
  let currentSession = '';
  let isRunning = false;
  let elapsedTimer = null;

  // ─── mast: real attach-protocol backend (phase B) ──────────────────
  //
  // Wraps web/attach-client.js (the SSE consumer) and exposes the same
  // method surface app.js was already using against the phase-A stub.
  // The runPrompt method below bridges async SSE events back into the
  // sync callback shape (onToken / onToolCall / onToolResult / etc.)
  // the renderer expects.

  // Latest backend-reported state, fed by status-update / usage-update
  // events. Snapshot in the sidebar and status bar.
  const latest = {
    capabilities: null,
    status: { model: '', provider: '', turnState: 'idle', contextPct: null, permMode: '' },
    usage: {
      tokensIn: 0,
      tokensOut: 0,
      costUSD: 0,
      turns: 0,
      // Per-model breakdown from usage-update.by_model (v1.1.0+). Keys
      // are model IDs; values are { tokensIn, tokensOut, costUSD, turns }.
      byModel: {},
      // Authoritative per-turn cost with cache attribution from
      // usage-update.last_turn (v1.1.1+). Populated on each usage-update
      // that carries a last_turn sub-object; stamped onto the latest
      // assistant footer when the model wraps a turn.
      lastTurn: null,
    },
    sessions: [],
    // When the server emits turn-error kind=cost_ceiling, we freeze the
    // input and show a banner. Cleared on reconnect / session switch.
    costCeilingHit: false,
  };
  // Inbox coalesce: prompt_id → last state we saw ('queued' | 'dequeued').
  // Consumer of the "queued" toast dismisses on 'dequeued'.
  const inboxState = new Map();

  // Per-active-turn dispatch state. runPrompt populates these when a
  // turn starts; the SSE event router uses them to fan tokens / tool
  // calls / results into the right rendering callbacks.
  let activeTurn = null;

  const mast = {
    client: null,

    async init({ endpoint, token }) {
      if (typeof window.AttachClient !== 'function') {
        throw new Error(
          'AttachClient global missing — check that attach-client.js loaded before app.js'
        );
      }
      const client = new window.AttachClient({
        endpoint,
        token,
        onConnectionState: (state) => setConnectionState(state),
        onEvent: (ev) => dispatchAttachEvent(ev),
      });
      const session = await client.autoSelectSession();
      currentSession = session.id;
      await client.connect();
      this.client = client;
      connected = true;
      return { ok: true };
    },

    async listModels() {
      // The attach protocol doesn't expose a model catalog directly —
      // only the current model surfaces via status-update. Return a
      // single-entry list reflecting what the backend reports until we
      // grow a dedicated /models endpoint upstream.
      if (latest.status.model) {
        return [{ id: latest.status.model, label: latest.status.model }];
      }
      return [];
    },

    async setModel(_id) {
      // Verified 2026-07-20: no model-switch endpoint exists in
      // core-agent (grep of pkg/attach/handlers_operator.go). The
      // current model is server-driven via status-update events. A
      // server-side POST /sessions/{app}/{sid}/model endpoint is a
      // v0.3.0 item (needs SwitchModelProvider capability interface
      // on the agent side); see mast-web plan doc §8.4.
      throw new Error(
        'Model switching requires a server-side endpoint that does not exist yet. ' +
          'Tracked as a v0.3.0 item.'
      );
    },

    async listSessions() {
      if (!this.client) return [];
      const sessions = await this.client.listSessions();
      latest.sessions = sessions;
      return sessions.map((s) => ({ ...s, active: s.id === currentSession }));
    },

    async switchSession(id) {
      if (!this.client) throw new Error('not connected');
      await this.client.selectSession(id);
      currentSession = id;
    },

    async listMcpServers() {
      if (!this.client) return [];
      // /tools returns the merged tool catalog; the MCP-namespaced
      // entries are <server>_<tool>. Bucket them back into server
      // groups for display.
      const tools = await this.client.listTools();
      const byServer = new Map();
      (tools || []).forEach((t) => {
        const name = t.name || t;
        const idx = name.indexOf('_');
        if (idx <= 0) return;
        const server = name.substring(0, idx);
        const bucket = byServer.get(server) || { name: server, status: 'connected', tools: [] };
        bucket.tools.push(name.substring(idx + 1));
        byServer.set(server, bucket);
      });
      return Array.from(byServer.values());
    },

    async listSpecialists() {
      if (!this.client) return [];
      // Specialists surface via /agents — each registered subagent is
      // listed. Filter to the ones the backend marks as specialist-
      // shaped when that field lands; for now, return all sub-agents.
      const agents = await this.client.listAgents();
      return (agents || []).map((a) => ({
        name: a.name || a,
        description: a.description || '',
      }));
    },

    async getStats() {
      // Real numbers straight from the state fed by usage-update
      // events. byModel + lastTurn come from the v1.2.0 alignment in
      // PR 1 (last_turn is authoritative per-turn cost with cache
      // attribution; by_model powers per-model breakdown).
      const perModel = Object.entries(latest.usage.byModel || {})
        .map(([model, m]) => ({
          model,
          tokensIn: m.tokensIn,
          tokensOut: m.tokensOut,
          costUSD: m.costUSD,
          turns: m.turns,
        }))
        // Sort by descending cost, tie-break by descending output
        // tokens, then model name — same ordering as core-tui's
        // /stats renderer (slash_builtin.go:802-884).
        .sort(
          (a, b) =>
            b.costUSD - a.costUSD || b.tokensOut - a.tokensOut || a.model.localeCompare(b.model)
        );
      return {
        totalTurns: latest.usage.turns,
        totalTokenIn: latest.usage.tokensIn,
        totalTokenOut: latest.usage.tokensOut,
        totalCostUSD: latest.usage.costUSD,
        // Per-turn breakdown for the "last turn" row. Only included
        // when we've received a usage-update.last_turn (v1.1.1+).
        lastTurn: latest.usage.lastTurn,
        // Per-model breakdown; empty array when the backend only
        // emits totals (byModel absent or single model).
        byModel: perModel,
        // totalToolCalls / avgTtfbMs / avgTotalMs deliberately omitted
        // — attach doesn't surface these today. If future spec adds
        // them, add here.
      };
    },

    async exportSession(_id, fmt) {
      // Client-side export of the rendered transcript. Reads message
      // rows from the DOM (each .message has classes indicating role
      // and a text payload) and packages them + connection metadata.
      // Server-side JSONL export of the full eventlog is a v0.3.0
      // item (needs a dedicated attach endpoint reading pkg/audit).
      const rows = [];
      document.querySelectorAll('#output-area .message').forEach((el) => {
        const role = el.classList.contains('user')
          ? 'user'
          : el.classList.contains('assistant')
            ? 'assistant'
            : el.classList.contains('system')
              ? 'system'
              : 'unknown';
        // For assistant messages, prefer the raw markdown source we
        // stashed on data-source (renderer keeps it for reflow); fall
        // back to textContent otherwise.
        const text = el.dataset && el.dataset.source ? el.dataset.source : el.textContent;
        rows.push({ role, text: (text || '').trim() });
      });
      const payload = {
        exportedAt: new Date().toISOString(),
        endpoint: this.client ? this.client.endpoint : null,
        sessionId: currentSession || null,
        turns: turnCount,
        totalCostUSD: latest.usage.costUSD,
        messages: rows,
      };
      if (fmt === 'md') {
        // Simple markdown transcript for humans.
        const md = [
          '# mast session export',
          '',
          `- Session: \`${currentSession || '(none)'}\``,
          `- Endpoint: ${this.client ? this.client.endpoint : '(not connected)'}`,
          `- Turns: ${turnCount}`,
          `- Cost: $${latest.usage.costUSD.toFixed(6)}`,
          `- Exported: ${payload.exportedAt}`,
          '',
          '---',
          '',
          ...rows.map((r) => `**${r.role}:**\n\n${r.text}\n`),
        ].join('\n');
        return md;
      }
      return payload;
    },

    async clearSession() {
      // View-only clear. To hard-delete the server-side session, use
      // the per-row "Delete" button in the sidebar (POST /sessions +
      // DELETE /sessions/{app}/{sid} were wired in this PR — see the
      // deleteSession method below).
      const output = document.getElementById('output-area');
      if (output) output.innerHTML = '';
      addSystemMessage(
        'Browser view cleared. Server-side session state is untouched — use the sidebar delete button to remove the session on the backend.'
      );
    },

    async fetchIdentity() {
      // v0.2.0 placeholder. Real caller identity ships in PR 4 via
      // capabilities.caller_id (from the first frame) with GET
      // /whoami as the canonical fallback. Both delivered by
      // sibling core-agent PR (core-agent#329, spec v1.3.0).
      // Until then, surface a best-effort description so the sidebar
      // doesn't render an empty slot.
      if (!this.client) return { email: '(not connected)', source: 'none' };
      // If the backend has advertised capabilities.caller_id (rare
      // today; ships properly in v1.3.0), prefer it.
      const caps = this.client.capabilities;
      if (caps && caps.caller_id) {
        return { email: caps.caller_id, source: caps.server || 'attach' };
      }
      return {
        email: '(identity pending — server v1.3.0 will advertise via /whoami)',
        source: this.client.endpoint,
      };
    },

    async runPrompt(text, callbacks) {
      if (!this.client) throw new Error('not connected');
      // Set up the per-turn dispatch hooks. The SSE router calls these
      // as events arrive; the Promise resolves on turn-complete (or
      // rejects on turn-error). startedAt is used to compute totalMs.
      const startedAt = performance.now();
      return new Promise((resolve, reject) => {
        activeTurn = {
          callbacks,
          startedAt,
          done: false,
          finish(result, err) {
            if (this.done) return;
            this.done = true;
            activeTurn = null;
            if (err) reject(err);
            else resolve(result);
          },
        };
        // Send the operator prompt and wake the agent.
        Promise.resolve()
          .then(() => this.client.inject(text))
          .then(() => this.client.wake())
          .catch((e) => activeTurn && activeTurn.finish(null, e));
      });
    },
  };

  // ─── SSE event → renderer dispatch ─────────────────────────────────

  // Pairs onToolCall → onToolResult: each tool call pushes its
  // function-call ID; the matching tool-result pops by ID so out-of-
  // order completions still pair correctly (defensive — backends
  // typically emit in order).
  const pendingToolCallsByID = new Map();

  function dispatchAttachEvent(ev) {
    switch (ev.type) {
      case 'capabilities':
        latest.capabilities = ev.data;
        return;

      case 'status-update': {
        const s = ev.data || {};
        if (s.model !== undefined) latest.status.model = s.model;
        if (s.provider !== undefined) latest.status.provider = s.provider;
        if (s.turn_state !== undefined) latest.status.turnState = s.turn_state;
        if (s.context_pct !== undefined) latest.status.contextPct = s.context_pct;
        if (s.perm_mode !== undefined) latest.status.permMode = s.perm_mode;
        currentModel = latest.status.model || currentModel;
        updateStatusBar();
        return;
      }

      case 'usage-update': {
        const u = ev.data || {};
        latest.usage.tokensIn = u.tokens_in_total || 0;
        latest.usage.tokensOut = u.tokens_out_total || 0;
        latest.usage.costUSD = u.cost_usd_total || 0;
        latest.usage.turns = u.turns_total || 0;
        // by_model (v1.1.0+) — per-model breakdown for /stats.
        if (u.by_model && typeof u.by_model === 'object') {
          latest.usage.byModel = {};
          for (const [model, m] of Object.entries(u.by_model)) {
            if (!m) continue;
            latest.usage.byModel[model] = {
              tokensIn: m.tokens_in || 0,
              tokensOut: m.tokens_out || 0,
              costUSD: m.cost_usd || 0,
              turns: m.turns || 0,
            };
          }
        }
        // last_turn (v1.1.1+) — authoritative per-turn cost with cache
        // attribution. Populated by the server after pricing has already
        // applied cache-discount + operator overrides. Prefer this over
        // turn-complete.cost_usd when both arrive.
        if (u.last_turn && typeof u.last_turn === 'object') {
          const lt = u.last_turn;
          latest.usage.lastTurn = {
            tokensIn: lt.tokens_in || 0,
            tokensInCached: lt.tokens_in_cached || 0,
            tokensOut: lt.tokens_out || 0,
            costUSD: lt.cost_usd || 0,
            model: lt.model || '',
          };
        }
        turnCount = latest.usage.turns;
        totalCostUSD = latest.usage.costUSD;
        updateStatusBar();
        return;
      }

      case 'inbox': {
        // v1.1.0+: fires twice per prompt (queued, dequeued). Track by
        // prompt_id so consumers of a "queued" toast dismiss on the
        // matching "dequeued". For v0.1 we track state only; visual
        // toast wiring lands in a later PR.
        const box = ev.data || {};
        if (box.prompt_id) inboxState.set(box.prompt_id, box.state || '');
        return;
      }

      case 'turn-complete': {
        const tc = ev.data || {};
        if (activeTurn && activeTurn.callbacks) {
          // v1.1.0+: cost_usd is optional. When absent, fall through to
          // the next usage-update.last_turn.cost_usd (which is
          // authoritative — server-side pricing has already applied).
          const perTurnCost =
            typeof tc.cost_usd === 'number'
              ? tc.cost_usd
              : latest.usage.lastTurn
                ? latest.usage.lastTurn.costUSD
                : 0;
          activeTurn.finish({
            totalMs: tc.latency_ms || performance.now() - activeTurn.startedAt,
            tokens: { in: tc.tokens_in || 0, out: tc.tokens_out || 0 },
            costUSD: perTurnCost,
            toolCalls: [],
          });
        }
        return;
      }

      case 'turn-error': {
        const te = ev.data || {};
        const msg = `${te.kind || 'error'}: ${te.message || ''}${te.hint ? ' (' + te.hint + ')' : ''}`;
        // v1.2.0 kind=cost_ceiling — session refuses further turns until
        // a server-side reset. No matching turn-complete will follow.
        // Freeze input + show a persistent banner (reset UX will land
        // when core-agent ships /reset-ceiling; issue core-agent#331).
        if (te.kind === 'cost_ceiling') {
          latest.costCeilingHit = true;
          addSystemMessage(
            'Cost ceiling reached — session paused. Contact your administrator to reset.'
          );
        }
        if (activeTurn) activeTurn.finish(null, new Error(msg));
        else addSystemMessage('Turn error: ' + msg);
        return;
      }

      case 'stream-chunk': {
        if (!activeTurn || !activeTurn.callbacks.onToken) return;
        activeTurn.callbacks.onToken(ev.data.text);
        return;
      }

      case 'tool-call': {
        if (!activeTurn || !activeTurn.callbacks.onToolCall) return;
        const { id, name } = ev.data;
        const idx = name.indexOf('_');
        const server = idx > 0 ? name.substring(0, idx) : '';
        const tool = idx > 0 ? name.substring(idx + 1) : name;
        activeTurn.callbacks.onToolCall(server, tool);
        // Track the call so the matching result can be paired even
        // when the renderer dropped the pending element (defensive).
        if (id) pendingToolCallsByID.set(id, { server, tool });
        return;
      }

      case 'tool-result': {
        if (!activeTurn || !activeTurn.callbacks.onToolResult) return;
        const { id, name, response, latencyMs } = ev.data;
        const idx = (name || '').indexOf('_');
        const server = idx > 0 ? name.substring(0, idx) : '';
        const tool = idx > 0 ? name.substring(idx + 1) : name;
        activeTurn.callbacks.onToolResult(
          server,
          tool,
          // v1.2.0: latency_ms sidecar key inside the tool-result
          // response map (extracted by attach-client _fanoutAgentFrame).
          typeof latencyMs === 'number' ? latencyMs : 0,
          null,
          JSON.stringify(response || {}, null, 2)
        );
        if (id) pendingToolCallsByID.delete(id);
        return;
      }

      default:
        // Unknown events tolerated forward-compat.
        return;
    }
  }

  // ─── Status bar timer ──────────────────────────────────────────────

  function startElapsedTimer() {
    const wrap = document.getElementById('status-elapsed');
    const val = document.getElementById('status-elapsed-value');
    if (!wrap || !val) return;
    const start = performance.now();
    val.textContent = '0.0s';
    wrap.classList.add('active');
    elapsedTimer = setInterval(() => {
      val.textContent = ((performance.now() - start) / 1000).toFixed(1) + 's';
    }, 100);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    const wrap = document.getElementById('status-elapsed');
    if (wrap) wrap.classList.remove('active');
  }

  // ─── Config persistence (browser-local: backend endpoint + token) ──

  function getStoredConfig() {
    try {
      const raw = localStorage.getItem('mast-web:config');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function setStoredConfig(cfg) {
    localStorage.setItem('mast-web:config', JSON.stringify(cfg));
  }

  function checkFirstRun() {
    const cfg = getStoredConfig();
    if (!cfg || !cfg.endpoint) {
      document.getElementById('setup-modal').classList.add('open');
      return true;
    }
    return false;
  }

  // ─── Message rendering ─────────────────────────────────────────────

  const outputArea = document.getElementById('output-area');

  function addMessage(role, content, extraClass) {
    const div = document.createElement('div');
    div.className = 'message ' + role + (extraClass ? ' ' + extraClass : '');
    if (role === 'assistant') {
      const md = document.createElement('div');
      md.className = 'md-content';
      md.innerHTML = renderMarkdown(content);
      div.appendChild(md);
    } else {
      div.textContent = content;
    }
    outputArea.appendChild(div);
    outputArea.scrollTop = outputArea.scrollHeight;
    return div;
  }

  function addSystemMessage(text) {
    addMessage('system', text);
  }

  function addTurnFooter(result) {
    const div = document.createElement('div');
    div.className = 'turn-footer';
    div.textContent = `--- ${(result.totalMs / 1000).toFixed(2)}s, ${result.tokens.in} in / ${result.tokens.out} out tokens ---`;
    outputArea.appendChild(div);
    outputArea.scrollTop = outputArea.scrollHeight;
  }

  function injectCitations(streamingRef, claims, sources) {
    if (!streamingRef || !streamingRef.md) return;
    if (!sources || sources.length === 0) return;

    const mdEl = streamingRef.md;
    const usedIndices = new Set();

    (claims || []).forEach((claim) => {
      const text = (claim.text || '').trim();
      if (!text) return;
      const indices = claim.chunkIndices || [];
      const walker = document.createTreeWalker(mdEl, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf(text);
        if (idx >= 0) {
          const tail = node.splitText(idx + text.length);
          indices.forEach((i) => {
            const src = sources[i];
            if (!src || !src.uri) return;
            usedIndices.add(i);
            const sup = document.createElement('sup');
            sup.className = 'citation-pill';
            const a = document.createElement('a');
            a.href = src.uri;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = '[' + (i + 1) + ']';
            a.title = src.title || src.uri;
            sup.appendChild(a);
            tail.parentNode.insertBefore(sup, tail);
          });
          break;
        }
      }
    });

    // Sources strip — show every source even if no support span matched
    // (keeps numbering aligned with the inline pills).
    const stripContainer = document.createElement('div');
    stripContainer.className = 'citation-sources';
    const label = document.createElement('span');
    label.className = 'citation-sources-label';
    label.textContent = 'Sources:';
    stripContainer.appendChild(label);

    sources.forEach((src, i) => {
      if (!src.uri) return;
      const a = document.createElement('a');
      a.href = src.uri;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      let host = src.uri;
      try {
        host = new URL(src.uri).hostname.replace(/^www\./, '');
      } catch {
        // keep raw URI as fallback
      }
      a.textContent = '[' + (i + 1) + '] ' + host;
      a.title = src.title || src.uri;
      if (!usedIndices.has(i)) a.classList.add('unused');
      stripContainer.appendChild(a);
    });

    streamingRef.el.appendChild(stripContainer);
    outputArea.scrollTop = outputArea.scrollHeight;
  }

  function addBuiltinToolMessage(label, items) {
    items.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'message builtin-tool';
      const labelSpan = document.createElement('span');
      labelSpan.className = 'builtin-tool-label';
      labelSpan.textContent = label;
      const code = document.createElement('code');
      code.textContent = item;
      div.appendChild(labelSpan);
      div.appendChild(code);
      outputArea.appendChild(div);
    });
    outputArea.scrollTop = outputArea.scrollHeight;
  }

  function addToolPendingMessage(server, tool) {
    const div = document.createElement('div');
    div.className = 'message tool-pending';
    const headerRow = document.createElement('div');
    headerRow.className = 'tool-row';
    headerRow.innerHTML =
      '<span class="tool-icon">⚒</span>' +
      '<span class="tool-verb">Using</span>' +
      '<code class="tool-name">' +
      escapeHtml(server) +
      '_' +
      escapeHtml(tool) +
      '</code>' +
      '<span class="tool-latency"></span>';
    div.appendChild(headerRow);
    outputArea.appendChild(div);
    outputArea.scrollTop = outputArea.scrollHeight;
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
    if (latencyEl && latencyMs > 0) {
      latencyEl.textContent = '(' + latencyMs.toFixed(0) + 'ms)';
    }

    // Click-to-expand JSON viewer.
    const headerRow = el.querySelector('.tool-row');
    if (!headerRow) return;
    const payload = errMsg || resultJSON;
    if (!payload) return;

    const caret = document.createElement('span');
    caret.className = 'tool-caret';
    caret.textContent = '▶';
    headerRow.appendChild(caret);
    headerRow.classList.add('tool-row-expandable');

    const body = document.createElement('div');
    body.className = 'tool-body';
    const viewer = document.createElement('div');
    viewer.className = 'json-viewer';
    try {
      viewer.textContent = JSON.stringify(JSON.parse(payload), null, 2);
    } catch {
      viewer.textContent = payload;
    }
    body.appendChild(viewer);
    el.appendChild(body);

    headerRow.addEventListener('click', () => {
      const isOpen = el.classList.toggle('open');
      caret.textContent = isOpen ? '▼' : '▶';
    });
  }

  function createStreamingMessage() {
    const div = document.createElement('div');
    div.className = 'message assistant';
    const md = document.createElement('div');
    md.className = 'md-content';
    div.appendChild(md);
    outputArea.appendChild(div);
    return { el: div, md: md, text: '' };
  }

  const thinkingPhrases = [
    'Thinking',
    'Asking the model…',
    'Reasoning through your request',
    'Coordinating tool calls',
  ];

  function startThinking() {
    const el = document.createElement('div');
    el.className = 'thinking';
    const pick = () => thinkingPhrases[Math.floor(Math.random() * thinkingPhrases.length)];
    el.textContent = pick();
    outputArea.appendChild(el);
    outputArea.scrollTop = outputArea.scrollHeight;
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

  function updateStreamingMessage(msg, token) {
    msg.text += token;
    msg.md.innerHTML = renderMarkdown(msg.text);
    outputArea.scrollTop = outputArea.scrollHeight;
  }

  // ─── Markdown rendering (marked + highlight.js, configured once) ───

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
    div.appendChild(document.createTextNode(s));
    return div.innerHTML;
  }

  // ─── Sidebar: models, sessions, MCP servers, specialists ───────────

  async function updateModelSelect() {
    if (!connected) return;
    try {
      const models = await mast.listModels();
      const select = document.getElementById('model-select');
      select.innerHTML = '';
      (models || []).forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        if (m.id === currentModel) opt.selected = true;
        select.appendChild(opt);
      });
    } catch (e) {
      console.error('listModels error:', e);
    }
  }

  async function updateSessionList() {
    if (!connected) return;
    const container = document.getElementById('session-list');
    container.innerHTML = '';
    try {
      const sessions = await mast.listSessions();
      if (!sessions || sessions.length === 0) {
        container.innerHTML = '<div style="font-size:11px;color:var(--text-dim)">No sessions</div>';
        return;
      }
      sessions.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'server-item';
        if (s.active) item.classList.add('active');
        const info = document.createElement('div');
        info.innerHTML = `<span class="name">${escapeHtml(s.label || s.id)}</span>`;
        item.appendChild(info);
        item.onclick = async () => {
          await mast.switchSession(s.id);
          updateSessionList();
          updateStatusBar();
        };
        container.appendChild(item);
      });
    } catch {
      container.innerHTML =
        '<div style="font-size:11px;color:var(--red)">Error loading sessions</div>';
    }
  }

  async function updateServerList() {
    if (!connected) return;
    const container = document.getElementById('server-list');
    container.innerHTML = '';
    try {
      const servers = await mast.listMcpServers();
      if (!servers || servers.length === 0) {
        container.innerHTML =
          '<div style="font-size:11px;color:var(--text-dim)">No MCP servers</div>';
        return;
      }
      servers.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'server-item';
        const statusClass =
          s.status && s.status.startsWith('connected')
            ? 'connected'
            : s.status === 'connecting'
              ? 'connecting'
              : 'error';
        const info = document.createElement('div');
        info.innerHTML =
          `<span class="name">${escapeHtml(s.name)}</span><br>` +
          `<span class="status ${statusClass}">${escapeHtml(s.status || 'unknown')}</span>`;
        item.appendChild(info);
        container.appendChild(item);
      });
    } catch {
      container.innerHTML =
        '<div style="font-size:11px;color:var(--red)">Error loading servers</div>';
    }
  }

  async function updateSpecialistList() {
    if (!connected) return;
    const container = document.getElementById('specialist-list');
    container.innerHTML = '';
    try {
      const specialists = await mast.listSpecialists();
      if (!specialists || specialists.length === 0) {
        container.innerHTML =
          '<div style="font-size:11px;color:var(--text-dim)">None registered</div>';
        return;
      }
      specialists.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'server-item';
        const info = document.createElement('div');
        info.innerHTML =
          `<span class="name">${escapeHtml(s.name)}</span><br>` +
          `<span class="status">${escapeHtml(s.description || '').slice(0, 60)}</span>`;
        item.appendChild(info);
        container.appendChild(item);
      });
    } catch {
      container.innerHTML =
        '<div style="font-size:11px;color:var(--red)">Error loading specialists</div>';
    }
  }

  async function fetchIdentity() {
    try {
      const info = await mast.fetchIdentity();
      document.getElementById('identity-info').textContent = info.email || 'Unknown';
    } catch {
      document.getElementById('identity-info').textContent = 'Backend unreachable';
    }
  }

  // ─── Status bar ────────────────────────────────────────────────────

  function setConnectionState(state) {
    const el = document.getElementById('status-connection');
    if (!el) return;
    el.classList.remove('connected', 'connecting', 'disconnected');
    el.classList.add(state);
    const label =
      state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting…' : 'disconnected';
    el.textContent = `⬤ ${label}`;
  }

  function updateBackendInfo() {
    const cfg = getStoredConfig();
    const el = document.getElementById('backend-info');
    if (!el) return;
    el.textContent = cfg && cfg.endpoint ? cfg.endpoint : 'Not configured';
  }

  function updateStatusBar() {
    document.getElementById('status-model').textContent = 'Model: ' + (currentModel || '—');
    document.getElementById('status-session').textContent = 'Session: ' + (currentSession || '—');
    document.getElementById('status-turns').textContent = 'Turns: ' + turnCount;
    document.getElementById('status-cost').textContent = '$' + totalCostUSD.toFixed(2);
  }

  // ─── Prompt submission ─────────────────────────────────────────────

  async function submitPrompt(text) {
    if (!connected || isRunning) return;
    text = text.trim();
    if (!text) return;

    if (text.startsWith('/')) {
      await handleSlashCommand(text);
      return;
    }

    isRunning = true;
    document.getElementById('send-btn').disabled = true;
    addMessage('user', text);

    startElapsedTimer();
    const thinking = startThinking();
    let streaming = null;
    let activityStarted = false;
    const pendingToolEls = []; // FIFO — paired 1:1 with onToolResult
    const stopThinkingOnce = () => {
      if (!activityStarted) {
        thinking.stop();
        activityStarted = true;
      }
    };

    try {
      const result = await mast.runPrompt(text, {
        onToken: (token) => {
          stopThinkingOnce();
          if (!streaming) streaming = createStreamingMessage();
          updateStreamingMessage(streaming, token);
        },
        onToolCall: (server, tool) => {
          stopThinkingOnce();
          streaming = null;
          pendingToolEls.push(addToolPendingMessage(server, tool));
        },
        onToolResult: (server, tool, latencyMs, errMsg, resultJSON) => {
          const el = pendingToolEls.shift();
          completeToolMessage(el, latencyMs, errMsg, resultJSON);
        },
        onSearchQueries: (queries) => {
          stopThinkingOnce();
          streaming = null;
          addBuiltinToolMessage('🔍 Search', Array.from(queries));
        },
        onURLFetch: (urls) => {
          stopThinkingOnce();
          streaming = null;
          addBuiltinToolMessage('🌐 URL fetched', Array.from(urls));
        },
        onGrounding: (claims, sources) => {
          injectCitations(streaming, Array.from(claims || []), Array.from(sources || []));
        },
      });
      addTurnFooter(result);
      turnCount++;
      updateStatusBar();
    } catch (e) {
      addSystemMessage('Error: ' + e);
    } finally {
      thinking.stop();
      stopElapsedTimer();
      // safety net: mark any orphaned pending indicators as failed
      pendingToolEls.forEach((el) => completeToolMessage(el, 0, 'turn ended', ''));
      pendingToolEls.length = 0;
      isRunning = false;
      document.getElementById('send-btn').disabled = false;
    }
  }

  // ─── Slash commands ────────────────────────────────────────────────

  const slashCommands = {
    '/help': cmdHelp,
    '/model': cmdModel,
    '/sessions': cmdSessions,
    '/mcp': cmdMcp,
    '/specialists': cmdSpecialists,
    '/stats': cmdStats,
    '/batch': cmdBatch,
    '/export': cmdExport,
    '/clear': cmdClear,
    '/whoami': cmdWhoami,
    '/endpoint': cmdEndpoint,
  };

  async function handleSlashCommand(input) {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    for (const [prefix, handler] of Object.entries(slashCommands)) {
      if (cmd === prefix || cmd.startsWith(prefix + ' ')) {
        await handler(args, input);
        return;
      }
    }
    addSystemMessage('Unknown command: ' + cmd + '. Type /help for available commands.');
  }

  function cmdHelp() {
    const helpText = [
      '/help              — Show this help',
      '/model [name]      — List or switch model',
      '/sessions [list|switch <id>]  — Manage sessions',
      '/mcp list          — Show MCP servers (backend-configured; read-only)',
      '/specialists list  — Show registered specialists',
      '/stats             — Show session stats',
      '/batch             — Open batch panel',
      '/export [fmt]      — Export session (json|md)',
      '/clear             — Clear current session messages',
      '/whoami            — Show backend identity',
      '/endpoint          — Reconfigure backend endpoint',
    ].join('\n');
    addSystemMessage(helpText);
  }

  async function cmdModel(args) {
    if (!connected) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    if (args.length === 0) {
      const models = await mast.listModels();
      const list = (models || [])
        .map((m) => `${m.id === currentModel ? '> ' : '  '}${m.id} (${m.label})`)
        .join('\n');
      addSystemMessage('Models:\n' + list);
      return;
    }
    const name = args[0];
    try {
      await mast.setModel(name);
      currentModel = name;
      updateModelSelect();
      updateStatusBar();
      addSystemMessage('Switched to ' + name);
    } catch (e) {
      addSystemMessage('Failed: ' + e);
    }
  }

  async function cmdSessions(args) {
    if (!connected) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    const sub = (args[0] || 'list').toLowerCase();
    if (sub === 'list') {
      const sessions = await mast.listSessions();
      if (!sessions || sessions.length === 0) {
        addSystemMessage('No sessions.');
        return;
      }
      const list = sessions
        .map((s) => `${s.active ? '> ' : '  '}${s.id}  ${s.label || ''}`)
        .join('\n');
      addSystemMessage('Sessions:\n' + list);
    } else if (sub === 'switch') {
      const id = args[1];
      if (!id) {
        addSystemMessage('Usage: /sessions switch <id>');
        return;
      }
      await mast.switchSession(id);
      updateSessionList();
      updateStatusBar();
      addSystemMessage('Switched to ' + id);
    } else {
      addSystemMessage('Usage: /sessions [list|switch <id>]');
    }
  }

  async function cmdMcp(args) {
    if (!connected) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    const sub = (args[0] || 'list').toLowerCase();
    if (sub === 'list') {
      const servers = await mast.listMcpServers();
      if (!servers || servers.length === 0) {
        addSystemMessage(
          "No MCP servers configured on the backend. Configure them in the backend's .agents/mcp.json."
        );
        return;
      }
      const list = servers.map((s) => `  ${s.name}: ${s.status}`).join('\n');
      addSystemMessage('MCP Servers (backend-configured, read-only):\n' + list);
    } else {
      addSystemMessage(
        'MCP server lifecycle is backend-controlled. /mcp list shows what the backend has configured.'
      );
    }
  }

  async function cmdSpecialists(_args) {
    if (!connected) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    const specs = await mast.listSpecialists();
    if (!specs || specs.length === 0) {
      addSystemMessage('No specialists registered on the backend.');
      return;
    }
    const list = specs.map((s) => `  ${s.name}: ${s.description || ''}`).join('\n');
    addSystemMessage('Specialists:\n' + list);
  }

  async function cmdStats() {
    if (!connected) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    try {
      const s = await mast.getStats();
      addSystemMessage(
        `Stats:\n` +
          `  Turns:       ${s.totalTurns}\n` +
          `  Tokens in:   ${s.totalTokenIn}\n` +
          `  Tokens out:  ${s.totalTokenOut}\n` +
          `  Tool calls:  ${s.totalToolCalls}\n` +
          `  Cost:        $${(s.totalCostUSD || 0).toFixed(4)}\n` +
          `  Avg TTFB:    ${s.avgTtfbMs.toFixed(0)}ms\n` +
          `  Avg total:   ${s.avgTotalMs.toFixed(0)}ms`
      );
    } catch (e) {
      addSystemMessage('Error: ' + e);
    }
  }

  function cmdBatch() {
    const panel = document.getElementById('batch-panel');
    panel.classList.toggle('open');
  }

  async function cmdExport(args) {
    if (!connected) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    const fmt = args[0] || 'json';
    try {
      const data = await mast.exportSession(currentSession, fmt);
      let content, mimeType, ext;
      if (fmt === 'md') {
        content = data;
        mimeType = 'text/markdown';
        ext = 'md';
      } else {
        content = JSON.stringify(data, null, 2);
        mimeType = 'application/json';
        ext = 'json';
      }
      downloadFile(`mast-session.${ext}`, content, mimeType);
      addSystemMessage('Session exported as ' + ext);
    } catch (e) {
      addSystemMessage('Export failed: ' + e);
    }
  }

  async function cmdClear() {
    if (!connected) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    outputArea.innerHTML = '';
    await mast.clearSession();
    turnCount = 0;
    totalCostUSD = 0;
    addSystemMessage('Session cleared.');
    updateStatusBar();
  }

  async function cmdWhoami() {
    try {
      const info = await mast.fetchIdentity();
      addSystemMessage(
        `Identity:\n  Email:   ${info.email || '(unknown)'}\n  Source:  ${info.source || '(unknown)'}`
      );
    } catch (e) {
      addSystemMessage('Cannot reach backend: ' + e.message);
    }
  }

  function cmdEndpoint() {
    document.getElementById('setup-modal').classList.add('open');
  }

  // ─── Batch run ─────────────────────────────────────────────────────

  let batchData = [];
  const sortDir = {};

  document.getElementById('batch-run-btn').addEventListener('click', async () => {
    if (!connected) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    const input = document.getElementById('batch-input').value.trim();
    if (!input) return;
    const prompts = input.split('\n').filter((l) => l.trim());
    const resultsDiv = document.getElementById('batch-results');
    resultsDiv.innerHTML =
      '<div style="color:var(--text-dim)">Running batch (stub — phase B wires real backend)…</div>';
    try {
      // Phase A: simulate a batch via repeated stub runPrompt calls so
      // the table rendering is exercised. Phase B replaces with a real
      // batched backend call if the attach protocol grows one, or with
      // a sequential loop over real runPrompt.
      const entries = [];
      for (const p of prompts) {
        const r = await mast.runPrompt(p, {});
        entries.push({ prompt: p, result: { ...r, ttfbMs: 50, toolCalls: r.toolCalls || [] } });
      }
      const stats = {
        totalTurns: entries.length,
        totalTokenIn: entries.reduce((s, e) => s + e.result.tokens.in, 0),
        totalTokenOut: entries.reduce((s, e) => s + e.result.tokens.out, 0),
        avgTtfbMs: entries.reduce((s, e) => s + e.result.ttfbMs, 0) / Math.max(1, entries.length),
        avgTotalMs: entries.reduce((s, e) => s + e.result.totalMs, 0) / Math.max(1, entries.length),
      };
      renderBatchTable(entries, stats);
    } catch (e) {
      resultsDiv.innerHTML =
        '<div style="color:var(--red)">Batch error: ' + escapeHtml(String(e)) + '</div>';
    }
  });

  function renderBatchTable(entries, batchStats) {
    batchData = entries;
    const resultsDiv = document.getElementById('batch-results');
    if (!entries || entries.length === 0) {
      resultsDiv.innerHTML = '<div style="color:var(--text-dim)">No results</div>';
      return;
    }
    let html = '<table><thead><tr>';
    html += '<th data-sort="prompt">Prompt</th>';
    html += '<th data-sort="totalMs">Total (ms)</th>';
    html += '<th data-sort="ttfbMs">TTFB (ms)</th>';
    html += '<th data-sort="toolCalls">Tools</th>';
    html += '<th data-sort="tokensIn">In</th>';
    html += '<th data-sort="tokensOut">Out</th>';
    html += '<th>Status</th>';
    html += '</tr></thead><tbody>';
    entries.forEach((e) => {
      html += '<tr>';
      html += `<td>${escapeHtml(e.prompt.slice(0, 60))}</td>`;
      if (e.error) {
        html += `<td colspan="5" style="color:var(--red)">${escapeHtml(e.error)}</td>`;
        html += '<td style="color:var(--red)">Error</td>';
      } else {
        const r = e.result;
        html += `<td>${r.totalMs.toFixed(0)}</td>`;
        html += `<td>${r.ttfbMs.toFixed(0)}</td>`;
        html += `<td>${(r.toolCalls || []).length}</td>`;
        html += `<td>${r.tokens.in}</td>`;
        html += `<td>${r.tokens.out}</td>`;
        html += '<td style="color:var(--green)">OK</td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table>';
    if (batchStats) {
      html +=
        `<div style="margin-top:8px;font-size:11px;color:var(--text-dim)">` +
        `Summary: ${batchStats.totalTurns} prompts, ` +
        `${batchStats.totalTokenIn} in / ${batchStats.totalTokenOut} out tokens, ` +
        `avg TTFB ${batchStats.avgTtfbMs.toFixed(0)}ms, avg total ${batchStats.avgTotalMs.toFixed(0)}ms</div>`;
    }
    resultsDiv.innerHTML = html;
    resultsDiv.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => sortBatchTable(th.dataset.sort));
    });
  }

  function sortBatchTable(field) {
    sortDir[field] = !(sortDir[field] || false);
    const asc = sortDir[field];
    batchData.sort((a, b) => {
      let va, vb;
      if (field === 'prompt') {
        va = a.prompt;
        vb = b.prompt;
      } else if (a.error || b.error) {
        return a.error ? 1 : -1;
      } else {
        const ra = a.result;
        const rb = b.result;
        if (field === 'totalMs') {
          va = ra.totalMs;
          vb = rb.totalMs;
        } else if (field === 'ttfbMs') {
          va = ra.ttfbMs;
          vb = rb.ttfbMs;
        } else if (field === 'toolCalls') {
          va = (ra.toolCalls || []).length;
          vb = (rb.toolCalls || []).length;
        } else if (field === 'tokensIn') {
          va = ra.tokens.in;
          vb = rb.tokens.in;
        } else if (field === 'tokensOut') {
          va = ra.tokens.out;
          vb = rb.tokens.out;
        }
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    });
    renderBatchTable(batchData);
  }

  document.getElementById('batch-export-btn').addEventListener('click', () => {
    if (!batchData || batchData.length === 0) return;
    let csv = 'Prompt,Total (ms),TTFB (ms),Tool Calls,Tokens In,Tokens Out,Status\n';
    batchData.forEach((e) => {
      const prompt = '"' + e.prompt.replace(/"/g, '""') + '"';
      if (e.error) {
        csv += `${prompt},,,,,,Error: ${e.error.replace(/,/g, ';')}\n`;
      } else {
        const r = e.result;
        csv += `${prompt},${r.totalMs.toFixed(0)},${r.ttfbMs.toFixed(0)},${(r.toolCalls || []).length},${r.tokens.in},${r.tokens.out},OK\n`;
      }
    });
    downloadFile('mast-batch.csv', csv, 'text/csv');
  });

  document.getElementById('batch-close').addEventListener('click', () => {
    document.getElementById('batch-panel').classList.remove('open');
  });

  // ─── File download helper ──────────────────────────────────────────

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Prompt-input event listeners ──────────────────────────────────

  const promptInput = document.getElementById('prompt-input');
  const sendBtn = document.getElementById('send-btn');

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitPrompt(promptInput.value);
      promptInput.value = '';
      promptInput.style.height = 'auto';
    }
  });

  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
  });

  sendBtn.addEventListener('click', () => {
    submitPrompt(promptInput.value);
    promptInput.value = '';
    promptInput.style.height = 'auto';
  });

  document.getElementById('model-select').addEventListener('change', async (e) => {
    if (!connected) return;
    const model = e.target.value;
    try {
      await mast.setModel(model);
      currentModel = model;
      updateStatusBar();
      addSystemMessage('Switched to ' + model);
    } catch (err) {
      addSystemMessage('Failed to switch model: ' + err);
    }
  });

  // ─── Setup modal handlers ──────────────────────────────────────────

  document.getElementById('setup-save').addEventListener('click', async () => {
    const endpoint = document.getElementById('setup-endpoint').value.trim();
    const token = document.getElementById('setup-token').value.trim();
    if (!endpoint) {
      alert('Backend endpoint is required.');
      return;
    }
    setStoredConfig({ endpoint, token });
    document.getElementById('setup-modal').classList.remove('open');
    updateBackendInfo();
    await connectToBackend(endpoint, token);
  });

  // ─── Sidebar buttons ───────────────────────────────────────────────

  document.getElementById('new-session-btn').addEventListener('click', () => cmdClear());
  document.getElementById('export-btn').addEventListener('click', () => cmdExport([]));

  // ─── Connection lifecycle ──────────────────────────────────────────

  async function connectToBackend(endpoint, token) {
    setConnectionState('connecting');
    try {
      await mast.init({ endpoint, token });
      setConnectionState('connected');
      addSystemMessage(`Connected to ${endpoint}.`);
      updateModelSelect();
      updateSessionList();
      updateServerList();
      updateSpecialistList();
      fetchIdentity();
      updateStatusBar();
    } catch (e) {
      setConnectionState('disconnected');
      addSystemMessage('Connection failed: ' + (e?.message || e));
    }
  }

  // ─── Boot ──────────────────────────────────────────────────────────

  async function boot() {
    updateBackendInfo();
    setConnectionState('disconnected');
    const cfg = getStoredConfig();
    if (cfg && cfg.endpoint) {
      await connectToBackend(cfg.endpoint, cfg.token || '');
    } else {
      checkFirstRun();
    }
  }

  boot();
})();
