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
// protocol. Phase A scope: rendering surface + slash-command shell.
// The `mast` global below is a STUB that returns mock data and prints
// "TODO: phase B" messages; phase B replaces it with a real
// attach-protocol client in attach-client.js.
//
// Rendering pipeline is ported from mastersingh24/cogo-wasm2 with
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

  // ─── Phase-A stub for the attach-protocol client ───────────────────
  // Phase B replaces this with a real implementation in attach-client.js.
  // The stub returns mock data so the rendering pipeline can be exercised
  // end-to-end without a backend.

  const mast = {
    async init({ endpoint, token }) {
      addSystemMessage(
        `[stub] would connect to ${endpoint} (token: ${token ? 'provided' : 'none'}) — phase B wires the real attach client`
      );
      connected = true;
      currentModel = 'gemini-3.5-pro';
      currentSession = 'mock-session-1';
      return { ok: true };
    },
    async listModels() {
      return [
        { id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
        { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      ];
    },
    async setModel(id) {
      currentModel = id;
      return { ok: true };
    },
    async listSessions() {
      return [{ id: 'mock-session-1', label: 'Mock session 1', active: true }];
    },
    async switchSession(id) {
      currentSession = id;
      addSystemMessage(`[stub] switched to ${id}`);
    },
    async listMcpServers() {
      return [];
    },
    async listSpecialists() {
      return [];
    },
    async getStats() {
      return {
        totalTurns: turnCount,
        totalTokenIn: 0,
        totalTokenOut: 0,
        totalToolCalls: 0,
        totalCostUSD: totalCostUSD,
        avgTtfbMs: 0,
        avgTotalMs: 0,
      };
    },
    async exportSession(_id, fmt) {
      return fmt === 'md' ? '# (stub session export)\n' : { stub: true, turns: turnCount };
    },
    async clearSession() {
      turnCount = 0;
      totalCostUSD = 0;
    },
    async fetchIdentity() {
      return { email: '(stub — phase B)', source: 'stub' };
    },
    async runPrompt(text, callbacks) {
      // Phase A: drive the rendering pipeline with a mock streamed response
      // so the UI is visually complete without a backend.
      const tokens = [
        'Phase A is the rendering port from `cogo-wasm2`. ',
        'The attach-protocol client lands in phase B. ',
        '\n\nYou submitted: ',
        '`',
        text.slice(0, 80),
        '`',
      ];
      for (const t of tokens) {
        callbacks.onToken?.(t);
        await new Promise((r) => setTimeout(r, 80));
      }
      // Demonstrate a tool-call render
      callbacks.onToolCall?.('mock', 'echo');
      await new Promise((r) => setTimeout(r, 120));
      callbacks.onToolResult?.('mock', 'echo', 120, null, JSON.stringify({ input: text }, null, 2));
      return { totalMs: 480, tokens: { in: text.length, out: 64 }, toolCalls: [] };
    },
  };

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
