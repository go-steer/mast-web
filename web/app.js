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

  // ─── State (v0.3.0 PR 1: source of truth in window.MastState) ─────
  //
  // State lives in window.MastState.session / .connection / .daemons
  // (observable stores under web/state/). This block wires two
  // module-scope mirrors — `latest` and `conn` — that stay in sync
  // via subscribe callbacks, so existing rendering code that reads
  // `latest.foo.bar` and `conn.state` etc. keeps working with no
  // per-call change. All WRITES go through the store's named actions
  // (sessionStore.patchStatus, connectionStore.setState, etc.) so
  // the store stays authoritative.
  //
  // Reactive rendering (renderers subscribe directly, no mirror
  // needed) is deliberately NOT part of this PR — that migration
  // happens in v0.3.0 PRs 3/5 where the render paths get restructured
  // anyway. Doing it here would balloon the diff without changing
  // behavior.
  if (!window.MastState || !window.MastState.session || !window.MastState.connection) {
    throw new Error(
      'MastState missing — check that web/state/*.js loaded before app.js in index.html'
    );
  }
  const sessionStore = window.MastState.session;
  const connectionStore = window.MastState.connection;

  // `latest` / `conn` are subscribe-updated snapshots of the two
  // stores; the module-scope let vars below (connected, isRunning,
  // currentSession, etc.) mirror the same data as simple identifiers
  // so pre-refactor read call sites need no per-line changes. All
  // writes go through the store actions (sessionStore.patchStatus,
  // connectionStore.setState, etc.) — the module vars are read-only
  // mirrors, updated when the store changes.
  let latest = sessionStore.store.get();
  let conn = connectionStore.store.get();

  let connected = conn.state === 'connected';
  let isRunning = conn.isRunning;
  let activeTurn = conn.activeTurn;
  let currentSession = latest.currentSession;
  let currentModel = latest.currentModel;
  let turnCount = latest.turnCount;
  let totalCostUSD = latest.totalCostUSD;

  sessionStore.store.subscribe((s) => {
    latest = s;
    currentSession = s.currentSession;
    currentModel = s.currentModel;
    turnCount = s.turnCount;
    totalCostUSD = s.totalCostUSD;
  });
  connectionStore.store.subscribe((c) => {
    conn = c;
    connected = c.state === 'connected';
    isRunning = c.isRunning;
    activeTurn = c.activeTurn;
  });

  // Timers are transient and don't belong in a store.
  let elapsedTimer = null;

  // ─── mast: real attach-protocol backend (phase B) ──────────────────
  //
  // Wraps web/attach-client.js (the SSE consumer) and exposes the same
  // method surface app.js was already using against the phase-A stub.
  // The runPrompt method below bridges async SSE events back into the
  // sync callback shape (onToken / onToolCall / onToolResult / etc.)
  // the renderer expects.

  // Inbox coalesce: prompt_id → last state we saw ('queued' | 'dequeued').
  // Consumer of the "queued" toast dismisses on 'dequeued'. State lives
  // in sessionStore.inboxState; this local mirror is a read-friendly
  // Map facade that mirrors the store's plain-object shape.
  const inboxState = {
    set(key, val) {
      sessionStore.recordInbox(key, val);
    },
    get(key) {
      return latest.inboxState[key];
    },
    has(key) {
      return Object.prototype.hasOwnProperty.call(latest.inboxState, key);
    },
  };

  // Per-active-turn dispatch state now lives in connectionStore. The
  // `activeTurn` mirror declared at the top of the file gives read
  // access to the current dispatch handle; runPrompt writes via
  // connectionStore.setActiveTurn.

  // ─── Capability manifest (v1.4.0+) ────────────────────────────────
  //
  // The capabilities first-frame (and optional status-update.capabilities
  // hot-merge) carries four fields the UI keys off:
  //   features       — { multi_session, mcp, specialists, ... } flags
  //                    that gate sidebar sections and affordances
  //   slash_commands — server-advertised slash commands; merged with
  //                    the client-side local set
  //   agent          — { name, description, model, provider, url, version }
  //                    that populates the "Connected to X" header slot
  //   caller_id      — display hint for the identity slot (real
  //                    lookup goes through /whoami)
  //
  // Feature-flag defaults when a flag is absent: assume enabled
  // (back-compat with pre-v1.4.0 servers that don't advertise).
  // Unknown feature flags are tolerated silently — forward-compat.
  //
  // Static metadata table for known server-side slash commands. Server
  // advertises which are available via capabilities.slash_commands;
  // the client renders known names with the pretty display below
  // and falls through to a generic entry for unknown names ("server-
  // advertised; no local help").
  const SERVER_SLASH_METADATA = {
    compact: {
      signature: '/compact [focus]',
      summary: 'Ask the agent to compact its context',
    },
    done: {
      signature: '/done [note]',
      summary: 'Checkpoint the current thread',
    },
    btw: {
      signature: '/btw <side-query>',
      summary: 'Ask a side question without disturbing the main turn',
    },
    subagent: {
      signature: '/subagent <spec>',
      summary: 'Dispatch a subagent',
    },
    replan: {
      signature: '/replan',
      summary: 'Ask the agent to replan the current task',
    },
    federate: {
      signature: '/federate <peer>',
      summary: 'Hand off to a peer agent (mast-specific)',
    },
  };

  function isFeatureEnabled(name) {
    const features = latest.capabilities && latest.capabilities.features;
    // Absent features map: assume all-on (pre-v1.4.0 server).
    if (!features || typeof features !== 'object') return true;
    // Absent flag: assume on (forward-compat with a client that
    // knows about more flags than the server advertises).
    if (!(name in features)) return true;
    return !!features[name];
  }

  function applyCapabilities(caps) {
    if (!caps) return;
    updateAgentInfo(caps.agent, caps.server);
    updateIdentityFromCapabilities(caps.caller_id);
    applyFeatureGating(caps.features);
    if (Array.isArray(caps.slash_commands)) {
      applyServerSlashCommands(caps.slash_commands);
    }
    applyObserverMode(caps.features);
  }

  // Observer mode — when features.observer_mode is true, the operator
  // is attached to a session someone (or something) else is driving.
  // Show a persistent banner so an operator doesn't type into a
  // read-only stream. Full observer-mode support (turn-complete-
  // driven assistant-footer stamping when no activeTurn exists,
  // per coretuiremote's StampLatestAssistantFooter pattern) is a
  // v0.3.0 chunk — needs the turn dispatch to accept externally-
  // driven turns, which requires refactoring the activeTurn /
  // runPrompt binding. Deferred; banner is the visible bit today.
  function applyObserverMode(features) {
    const isObserver = !!(features && features.observer_mode === true);
    let banner = document.getElementById('observer-banner');
    if (!isObserver) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'observer-banner';
      banner.className = 'message system';
      banner.style.borderLeft = '3px solid var(--brand-yellow, #f0b429)';
      banner.style.background = 'var(--bg-elevated, rgba(240,180,41,0.06))';
      const main = document.getElementById('output-area');
      if (main) main.insertBefore(banner, main.firstChild);
    }
    banner.textContent =
      'Attached as observer — this session is being driven elsewhere. Your prompts will be queued but full observer-mode footer support ships in a later version.';
  }

  function updateAgentInfo(agent, serverName) {
    const info = document.getElementById('agent-info');
    if (!info) return;
    if (!agent || typeof agent !== 'object') {
      info.hidden = true;
      info.textContent = '';
    } else {
      // "mast v0.1.0-dev (gemini-2.5-pro via vertex)"
      const parts = [];
      if (agent.name) parts.push(escapeHtml(agent.name));
      if (agent.version)
        parts.push('<span style="color:var(--text-dim)">' + escapeHtml(agent.version) + '</span>');
      const model = agent.model ? escapeHtml(agent.model) : '';
      const provider = agent.provider ? escapeHtml(agent.provider) : '';
      const modelBits = [model, provider ? 'via ' + provider : ''].filter(Boolean).join(' ');
      info.innerHTML =
        parts.join(' ') +
        (modelBits
          ? '<div style="font-size:11px;color:var(--text-dim)">' + modelBits + '</div>'
          : '') +
        (agent.description
          ? '<div style="font-size:11px;color:var(--text-dim);margin-top:4px">' +
            escapeHtml(agent.description) +
            '</div>'
          : '');
      info.hidden = false;
    }
    // Status-bar "powered by" slot — collapse to just the agent name
    // when we have one, else "attach protocol · <server>".
    const status = document.getElementById('status-agent');
    if (status) {
      if (agent && agent.name) {
        status.textContent = agent.name + (agent.model ? ' · ' + agent.model : '');
      } else if (serverName) {
        status.textContent = 'attach protocol · ' + serverName;
      } else {
        status.textContent = 'attach protocol';
      }
    }
  }

  function updateIdentityFromCapabilities(callerID) {
    const el = document.getElementById('identity-info');
    if (!el) return;
    if (callerID) {
      el.textContent = callerID;
      // Fire /whoami in the background to enrich with proxy_by /
      // source. Absorb errors — the caller_id display is enough.
      if (mast.client && typeof mast.client.whoami === 'function') {
        mast.client.whoami().then(
          (w) => renderIdentity(w),
          () => {}
        );
      }
    }
  }

  function renderIdentity(whoami) {
    const el = document.getElementById('identity-info');
    if (!el || !whoami || !whoami.identity) return;
    // "alice@example.com" or "alice@example.com via bot-service (proxied)"
    let line = escapeHtml(whoami.identity);
    if (whoami.proxy_by) {
      line +=
        ' <span style="color:var(--text-dim);font-size:11px">via ' +
        escapeHtml(whoami.proxy_by) +
        '</span>';
    }
    if (whoami.source && whoami.source !== 'bearer') {
      // Bearer is the common case; only annotate when it's not.
      line +=
        ' <span style="color:var(--text-dim);font-size:11px">(' +
        escapeHtml(whoami.source) +
        ')</span>';
    }
    if (whoami.admin) {
      line += ' <span style="color:var(--brand-yellow);font-size:10px">admin</span>';
    }
    el.innerHTML = line;
  }

  function applyFeatureGating(_features) {
    // Hide sidebar sections whose backing feature is explicitly false.
    // Mapping: feature flag → sidebar section id.
    const gates = {
      mcp: 'section-mcp',
      specialists: 'section-specialists',
      multi_session: 'section-sessions',
    };
    for (const [flag, sectionID] of Object.entries(gates)) {
      const el = document.getElementById(sectionID);
      if (!el) continue;
      el.hidden = !isFeatureEnabled(flag);
    }
    // Stop button visibility is also gated dynamically per-session
    // by interruptUnsupportedForSession + turn state, but feature-
    // flag gating suppresses it entirely when interrupt=false.
    if (!isFeatureEnabled('interrupt')) {
      const stop = document.getElementById('stop-btn');
      if (stop) stop.hidden = true;
    }
  }

  function applyServerSlashCommands(names) {
    // Server-advertised commands are stored for the /help output +
    // future autocomplete palette. Dispatch is handled generically
    // via cmdServerSlash — the router doesn't need a static entry.
    sessionStore.setServerSlashCommands(names);
  }

  const mast = {
    client: null,
    prompter: null,

    async init({ endpoint, token }) {
      if (typeof window.AttachClient !== 'function') {
        throw new Error(
          'AttachClient global missing — check that attach-client.js loaded before app.js'
        );
      }
      // Tear down any previous client + prompter so switching backends
      // via /endpoint's setup-save path doesn't leak an SSE stream
      // pointed at the outgoing endpoint. /attach's own cmdAttach
      // does its own explicit teardown; init handles the setup-modal
      // path (and any other caller).
      if (this.prompter) {
        try {
          this.prompter.disconnect();
        } catch {
          /* best effort */
        }
        this.prompter = null;
      }
      if (this.client && typeof this.client.disconnect === 'function') {
        try {
          this.client.disconnect();
        } catch {
          /* best effort */
        }
        this.client = null;
      }
      const client = new window.AttachClient({
        endpoint,
        token,
        onConnectionState: (state) => setConnectionState(state),
        onEvent: (ev) => dispatchAttachEvent(ev),
      });
      const session = await client.autoSelectSession();
      sessionStore.setCurrentSession(session.id);
      await client.connect();
      this.client = client;
      connectionStore.setClient(client);
      connectionStore.setState('connected');

      // Open the perms/stream subscription in parallel with the main
      // event stream. If the agent has no PromptBrokerProvider the
      // server 501s on subscribe; Prompter classifies that as
      // terminal and quietly stays disconnected.
      openPromptStream(endpoint, token, session.id);

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
      // Sort by last_touched_at desc so most-recently-active shows
      // first (matches the operator's mental model + core-tui's
      // session-picker ordering). Sessions without a timestamp
      // (older backends) sink to the bottom.
      sessions.sort((a, b) => {
        const at = a.lastTouchedAt ? Date.parse(a.lastTouchedAt) : 0;
        const bt = b.lastTouchedAt ? Date.parse(b.lastTouchedAt) : 0;
        return bt - at;
      });
      sessionStore.setSessions(sessions);
      return sessions.map((s) => ({ ...s, active: s.id === currentSession }));
    },

    async switchSession(id) {
      if (!this.client) throw new Error('not connected');
      await this.client.selectSession(id);
      sessionStore.setCurrentSession(id);
      // Restart the perms stream against the new session — prompts are
      // per-session, so a stale subscription against the outgoing sid
      // would never fire for prompts on the new one.
      openPromptStream(this.client.endpoint, this.client.token, id);
    },

    // v0.2.0: real create/delete via POST /sessions + DELETE
    // /sessions/{app}/{sid}. Both endpoints landed in core-agent
    // pkg/attach/handlers_create_session.go + handlers_delete_session.go.
    async createSession() {
      if (!this.client) throw new Error('not connected');
      const s = await this.client.createSession();
      return s;
    },

    async deleteSession(id) {
      if (!this.client) throw new Error('not connected');
      // Look up the app for this sid from the last listSessions() so
      // we can use the qualified path (safer than the shortcut which
      // 409s on multi-tenant collisions).
      const found = latest.sessions.find((s) => s.id === id);
      if (!found) throw new Error(`session ${id} not in the local list — reload the sidebar first`);
      if (id === 'default') {
        // Server would 403 anyway; guard client-side for a nicer
        // error and to avoid the pointless round trip.
        throw new Error('the bootstrap `default` session cannot be deleted');
      }
      await this.client.deleteSession(found.app, id);
      // Drop it from our snapshot so the sidebar re-renders without
      // waiting on the next list poll.
      sessionStore.setSessions(latest.sessions.filter((s) => s.id !== id));
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
        const turn = {
          callbacks,
          startedAt,
          done: false,
          finish(result, err) {
            if (this.done) return;
            this.done = true;
            connectionStore.setActiveTurn(null);
            if (err) reject(err);
            else resolve(result);
          },
        };
        connectionStore.setActiveTurn(turn);
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
    // Session-generation gate — drop events tagged with an outdated
    // stream generation. attach-core/client.js bumps sessionGen on
    // every connect()/selectSession() and tags each emitted event
    // with the gen at emit-time. Consumers use this to prevent
    // stragglers from a prior stream (still draining after the
    // operator hit switch mid-response) painting into the new
    // session's view. Ported from core-tui's agentcmd.go:229
    // sessionGen check.
    if (mast.client && typeof ev.gen === 'number' && ev.gen !== mast.client.sessionGen) {
      return;
    }
    switch (ev.type) {
      case 'capabilities':
        sessionStore.setCapabilities(ev.data);
        applyCapabilities(latest.capabilities);
        return;

      case 'status-update': {
        const s = ev.data || {};
        const statusPatch = {};
        if (s.model !== undefined) statusPatch.model = s.model;
        if (s.provider !== undefined) statusPatch.provider = s.provider;
        if (s.turn_state !== undefined) statusPatch.turnState = s.turn_state;
        if (s.context_pct !== undefined) statusPatch.contextPct = s.context_pct;
        if (s.perm_mode !== undefined) statusPatch.permMode = s.perm_mode;
        if (Object.keys(statusPatch).length > 0) sessionStore.patchStatus(statusPatch);
        if (s.model) sessionStore.setCurrentModel(s.model);
        // v1.4.0: status-update may carry an optional `capabilities`
        // merge for hot changes (e.g. MCP server registers mid-
        // session and features.mcp flips true). Merge into stored
        // capabilities; re-apply UI. No producer emits this yet as
        // of core-agent#344, but consumers wire the merge path once.
        if (s.capabilities && typeof s.capabilities === 'object') {
          sessionStore.mergeCapabilities(s.capabilities);
          applyCapabilities(latest.capabilities);
        }
        updateStatusBar();
        return;
      }

      case 'usage-update': {
        const u = ev.data || {};
        const usagePatch = {
          tokensIn: u.tokens_in_total || 0,
          tokensOut: u.tokens_out_total || 0,
          costUSD: u.cost_usd_total || 0,
          turns: u.turns_total || 0,
        };
        // by_model (v1.1.0+) — per-model breakdown for /stats.
        if (u.by_model && typeof u.by_model === 'object') {
          const byModel = {};
          for (const [model, m] of Object.entries(u.by_model)) {
            if (!m) continue;
            byModel[model] = {
              tokensIn: m.tokens_in || 0,
              tokensOut: m.tokens_out || 0,
              costUSD: m.cost_usd || 0,
              turns: m.turns || 0,
            };
          }
          usagePatch.byModel = byModel;
        }
        // last_turn (v1.1.1+) — authoritative per-turn cost with cache
        // attribution. Populated by the server after pricing has already
        // applied cache-discount + operator overrides. Prefer this over
        // turn-complete.cost_usd when both arrive.
        if (u.last_turn && typeof u.last_turn === 'object') {
          const lt = u.last_turn;
          usagePatch.lastTurn = {
            tokensIn: lt.tokens_in || 0,
            tokensInCached: lt.tokens_in_cached || 0,
            tokensOut: lt.tokens_out || 0,
            costUSD: lt.cost_usd || 0,
            model: lt.model || '',
          };
        }
        sessionStore.patchUsage(usagePatch);
        sessionStore.store.set({
          turnCount: usagePatch.turns,
          totalCostUSD: usagePatch.costUSD,
        });
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
          sessionStore.setCostCeilingHit(true);
          addSystemMessage(
            'Cost ceiling reached — session paused. Contact your administrator to reset.'
          );
        }
        if (activeTurn) activeTurn.finish(null, new Error(msg));
        else addSystemMessage('Turn error: ' + msg);
        return;
      }

      case 'stream-chunk': {
        // Suppress replay-flood tokens from the transcript. Aggregate
        // state (usage etc.) isn't affected by stream-chunk anyway.
        if (ev.replay) return;
        if (!activeTurn || !activeTurn.callbacks.onToken) return;
        activeTurn.callbacks.onToken(ev.data.text);
        return;
      }

      case 'tool-call': {
        if (ev.replay) return; // historical tool call, not for this session's view
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
        if (ev.replay) return; // historical tool result, not for this session's view
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
    if (cfg == null) {
      // Explicitly clear — boot's checkFirstRun then sees no stored
      // config and opens the setup modal, rather than looping on a
      // "null" string.
      localStorage.removeItem('mast-web:config');
      return;
    }
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

  // Insert a system message whose body is pre-rendered HTML. Used by
  // the generic server-slash dispatcher so responses can flow through
  // SlashRender's markdown / json / text renderers. Contents come
  // from SlashRender, which HTML-escapes its inputs — do NOT feed
  // arbitrary user or server strings here without sanitization.
  function addSystemMessageHTML(html) {
    const div = document.createElement('div');
    div.className = 'message system';
    div.innerHTML = html;
    outputArea.appendChild(div);
    outputArea.scrollTop = outputArea.scrollHeight;
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

        // Name + status badge. status is 'active' or 'idle' (v1.1.0+);
        // idle sessions are lazy-resumed on attach.
        const info = document.createElement('div');
        const statusText = s.status === 'idle' ? 'idle' : '';
        const badge = statusText
          ? `<span class="status ${escapeHtml(s.status)}" title="lazy-resumes on attach">${escapeHtml(statusText)}</span>`
          : '';
        info.innerHTML = `<span class="name">${escapeHtml(s.label || s.id)}</span> ${badge}`;
        info.style.cursor = 'pointer';
        info.onclick = async () => {
          if (s.active) return; // no-op click on the current session
          try {
            clearTranscriptView();
            await mast.switchSession(s.id);
            refreshAllSidebar();
            addSystemMessage(`Switched to session ${s.id}.`);
          } catch (e) {
            addSystemMessage('switch failed: ' + (e.message || e));
          }
        };
        item.appendChild(info);

        // Delete button — guard the bootstrap `default` sid client-side
        // (server 403s anyway, but the message is nicer this way).
        if (s.id !== 'default') {
          const del = document.createElement('button');
          del.className = 'remove-btn';
          del.textContent = '×';
          del.title = 'Delete session';
          del.onclick = async (evt) => {
            evt.stopPropagation();
            if (!window.confirm(`Delete session "${s.id}"? This cannot be undone.`)) return;
            try {
              await mast.deleteSession(s.id);
              addSystemMessage(`Deleted session ${s.id}.`);
              updateSessionList();
            } catch (e) {
              addSystemMessage('delete failed: ' + (e.message || e));
            }
          };
          item.appendChild(del);
        }

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
    // v1.4.0 path: identity is populated from capabilities.caller_id
    // + a background /whoami enrichment (see applyCapabilities +
    // updateIdentityFromCapabilities / renderIdentity). This function
    // is the fallback for older backends that don't advertise
    // caller_id — it uses the legacy mast.fetchIdentity() which
    // itself now prefers capabilities.caller_id when present but
    // falls back to a placeholder otherwise.
    try {
      // Skip if capabilities already delivered the identity.
      if (latest.capabilities && latest.capabilities.caller_id) return;
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
    text = text.trim();
    if (!text) return;
    if (isRunning) return;

    // Slash commands run regardless of connection state. Some of them
    // (/attach, /endpoint, /help, /clear) are the operator's escape
    // hatch when the SPA is disconnected — bailing on !connected here
    // would silently swallow the only recovery path they have.
    // Individual slash handlers decide for themselves whether they
    // need a live backend.
    if (text.startsWith('/')) {
      await handleSlashCommand(text);
      return;
    }

    if (!connected) {
      addSystemMessage(
        'Not connected — use /attach <url> [<token>] to connect to a backend, or /endpoint to reopen the setup modal.'
      );
      return;
    }

    connectionStore.setIsRunning(true);
    document.getElementById('send-btn').disabled = true;
    // Show the Stop button while a turn is in flight (hidden by
    // default; interrupt handler restores hidden state on finally).
    // If the backend has previously reported 412 (agent doesn't
    // support InterruptProvider), the button stays hidden throughout.
    showStopButton();
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
      sessionStore.incrementTurnCount();
      updateStatusBar();
    } catch (e) {
      addSystemMessage('Error: ' + e);
    } finally {
      thinking.stop();
      stopElapsedTimer();
      // safety net: mark any orphaned pending indicators as failed
      pendingToolEls.forEach((el) => completeToolMessage(el, 0, 'turn ended', ''));
      pendingToolEls.length = 0;
      connectionStore.setIsRunning(false);
      document.getElementById('send-btn').disabled = false;
      hideStopButton();
    }
  }

  // ─── Perms stream + modal ─────────────────────────────────────────
  //
  // A second SSE subscription — /sessions/{sid}/perms/stream — carries
  // permission prompts. Each frame opens the perms modal with the
  // prompt's tool / detail; the operator's Allow / Deny click POSTs
  // to /perms/respond with the frame ID + a wire-stable decision
  // string. 501 from the subscribe means the agent lacks the
  // PromptBrokerProvider capability; Prompter classifies as terminal.

  function openPromptStream(endpoint, token, sessionId) {
    if (mast.prompter) {
      mast.prompter.disconnect();
      mast.prompter = null;
    }
    if (!window.AttachCorePrompter || !window.AttachCorePrompter.Prompter) return;
    const p = new window.AttachCorePrompter.Prompter({
      endpoint,
      token,
      sessionId,
      onPrompt: (frame) => showPermsModal(frame),
      onTerminal: () => {
        addSystemMessage(
          'Perms stream unavailable — agent does not support interactive prompts or the stream permanently failed.'
        );
      },
    });
    p.connect();
    mast.prompter = p;
  }

  // Currently-open prompt frame. Buttons read this to know which ID
  // to respond with; overwriting means the newer prompt wins the
  // modal (rare but possible if the operator ignores a prompt long
  // enough for the agent to fire another).
  let currentPromptFrame = null;

  function showPermsModal(frame) {
    if (!frame || !frame.id) return;
    currentPromptFrame = frame;
    const overlay = document.getElementById('perms-modal');
    const title = document.getElementById('perms-modal-title');
    const body = document.getElementById('perms-modal-body');
    const scope = document.getElementById('perms-modal-scope');
    if (!overlay) return;
    // Reset the scope checkbox on every open — sticky state across
    // prompts is a footgun (an operator ticks it once and forgets).
    if (scope) scope.checked = false;
    if (title) {
      title.textContent = 'Permission request — ' + (frame.tool || frame.kind || 'tool');
    }
    if (body) {
      const parts = [];
      if (frame.detail) parts.push(escapeHtml(frame.detail));
      if (frame.verb)
        parts.push(
          '<div style="margin-top:8px"><strong>Verb:</strong> ' + escapeHtml(frame.verb) + '</div>'
        );
      if (frame.access)
        parts.push('<div><strong>Access:</strong> ' + escapeHtml(frame.access) + '</div>');
      if (frame.source)
        parts.push(
          '<div style="color:var(--text-dim);margin-top:8px;font-size:11px">Source: ' +
            escapeHtml(frame.source) +
            '</div>'
        );
      body.innerHTML = parts.join('') || '<em>No further detail provided.</em>';
    }
    overlay.classList.add('open');
  }

  function closePermsModal() {
    const overlay = document.getElementById('perms-modal');
    if (overlay) overlay.classList.remove('open');
    currentPromptFrame = null;
  }

  async function respondToPrompt(baseDecision) {
    const frame = currentPromptFrame;
    if (!frame || !mast.prompter) return;
    const scope = document.getElementById('perms-modal-scope');
    // Wire-stable decision strings from core-agent/pkg/attach/prompter.go's
    // DecisionFromWire mapping. Scope checkbox upgrades allow-once →
    // allow-session-tool (skip prompts for this tool for the session).
    let decision = baseDecision;
    if (baseDecision === 'allow-once' && scope && scope.checked) {
      decision = 'allow-session-tool';
    }
    closePermsModal();
    try {
      await mast.prompter.respond(frame.id, decision);
    } catch (e) {
      addSystemMessage('perms respond failed: ' + (e.message || e));
    }
  }

  // ─── Stop / interrupt ─────────────────────────────────────────────
  //
  // The Stop button is hidden by default and only shown while a turn
  // is in flight. If a call to /interrupt returns unsupported=true
  // (backend agent has no InterruptProvider), we remember that per
  // session (in sessionStore.interruptUnsupportedForSession) so
  // subsequent turns skip the affordance entirely.

  function showStopButton() {
    if (sessionStore.interruptUnsupportedFor(currentSession)) return;
    const btn = document.getElementById('stop-btn');
    if (btn) btn.hidden = false;
  }

  function hideStopButton() {
    const btn = document.getElementById('stop-btn');
    if (btn) btn.hidden = true;
  }

  async function handleStopClick() {
    if (!connected || !mast.client) return;
    const btn = document.getElementById('stop-btn');
    if (btn) btn.disabled = true;
    try {
      const r = await mast.client.interrupt();
      if (r.ok && r.interrupted === 'nothing-in-flight') {
        addSystemMessage('Nothing in flight to interrupt.');
      } else if (r.ok) {
        addSystemMessage('Turn interrupted.');
      } else if (r.unsupported) {
        sessionStore.markInterruptUnsupported(currentSession);
        addSystemMessage(
          'This agent does not support interruption (no InterruptProvider). Stop button hidden for this session.'
        );
        hideStopButton();
      }
    } catch (e) {
      addSystemMessage('interrupt failed: ' + (e.message || e));
    } finally {
      if (btn) btn.disabled = false;
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
    '/attach': cmdAttach,
  };

  async function handleSlashCommand(input) {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    // Client-side local commands take priority (they own /help,
    // /endpoint, /attach — no server round trip). Otherwise fall
    // through to server-advertised commands if the backend has
    // published a slash_commands list on the capabilities frame.
    for (const [prefix, handler] of Object.entries(slashCommands)) {
      if (cmd === prefix || cmd.startsWith(prefix + ' ')) {
        await handler(args, input);
        return;
      }
    }
    const bare = cmd.replace(/^\//, '');
    const serverNames = (latest.capabilities && latest.capabilities.slash_commands) || [];
    if (serverNames.includes(bare)) {
      await cmdServerSlash(bare, args);
      return;
    }
    addSystemMessage('Unknown command: ' + cmd + '. Type /help for available commands.');
  }

  // Generic dispatcher for any server-advertised slash command that
  // doesn't have a bespoke client-side handler. POSTs to the
  // canonical /sessions/{sid}/slash/<name> endpoint, dispatches the
  // response body through the shared slash-render module (registered
  // renderers: text / markdown / json; unknown _render → json).
  async function cmdServerSlash(name, args) {
    if (!connected || !mast.client) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    try {
      // Server slash endpoints accept arbitrary JSON bodies; for a
      // generic dispatcher we just pass through the raw args string
      // (best we can do without per-command schemas — that's the
      // v0.3.0 schema-driven work).
      const body = args.length > 0 ? { args: args.join(' ') } : {};
      const path =
        '/sessions/' + encodeURIComponent(currentSession) + '/slash/' + encodeURIComponent(name);
      const res = await mast.client._post(path, body);
      if (window.SlashRender && typeof window.SlashRender.renderSlashResponse === 'function') {
        const html = window.SlashRender.renderSlashResponse(res);
        // Render as a system message with the rendered HTML inlined.
        addSystemMessageHTML(html);
      } else {
        addSystemMessage(JSON.stringify(res, null, 2));
      }
    } catch (e) {
      addSystemMessage('/' + name + ' failed: ' + (e.message || e));
    }
  }

  function cmdHelp() {
    const localCommands = [
      '/help              — Show this help',
      '/attach <url> [<token>] [<sid>]  — Switch to a different backend daemon',
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
    ];
    // Merge server-advertised slash commands from capabilities.slash_commands.
    // Known names get pretty display from SERVER_SLASH_METADATA; unknown names
    // render generically ("no local help — server-advertised") so a new
    // command appearing server-side is discoverable even before the client
    // learns to render it richly.
    const serverNames = (latest.capabilities && latest.capabilities.slash_commands) || [];
    const serverLines = serverNames.map((name) => {
      const meta = SERVER_SLASH_METADATA[name];
      if (meta) {
        return `${meta.signature.padEnd(18)} — ${meta.summary}`;
      }
      return `/${name.padEnd(17)} — (server-advertised; no local help)`;
    });
    let helpText = localCommands.join('\n');
    if (serverLines.length > 0) {
      helpText += '\n\nServer-advertised:\n' + serverLines.join('\n');
    }
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
      sessionStore.setCurrentModel(name);
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
      clearTranscriptView();
      await mast.switchSession(id);
      refreshAllSidebar();
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
    sessionStore.store.set({ turnCount: 0, totalCostUSD: 0 });
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
    // Reopen the setup modal so the operator can retarget. The
    // actual reconnect happens in setup-save's click handler (which
    // properly tears down the previous client via mast.init). Modal
    // open on top of an existing connection is fine — the operator
    // can still cancel by closing the modal.
    document.getElementById('setup-modal').classList.add('open');
  }

  // /attach <url> [<token>] — cross-daemon switch. Disconnects the
  // current client + prompter, reconnects to a different backend, and
  // stores the new endpoint in localStorage so a reload sticks. This
  // is the minimum-viable form of cross-daemon /attach for v0.2.0 —
  // one daemon at a time. Full multi-daemon session fan-out (with
  // GET /peers-driven auto-discovery) is a v0.3.0+ item that grows
  // this into a real peer-picker.
  //
  // Optional third arg: an initial session ID to select on the new
  // backend. Empty falls through to the default autoSelectSession()
  // behavior (first session in the list).
  async function cmdAttach(args) {
    const url = args[0];
    if (!url) {
      addSystemMessage(
        'Usage: /attach <url> [<token>] [<sid>]  —  switch to a different backend daemon'
      );
      return;
    }
    // Basic URL sanity — reject anything that doesn't look like an
    // http(s):// URL to catch typos before we try to fetch.
    if (!/^https?:\/\//i.test(url)) {
      addSystemMessage(`/attach: expected http:// or https:// URL, got "${url}"`);
      return;
    }
    const token = args[1] || '';
    const initialSid = args[2] || '';

    addSystemMessage(`Attaching to ${url}${initialSid ? ' (session ' + initialSid + ')' : ''}...`);

    // Snapshot the current config so we can restore on failure — a
    // failed /attach used to leave the operator with a persisted bad
    // endpoint that auto-reconnected to on reload, bricking the SPA.
    const prevConfig = getStoredConfig();

    // Tear down the current client + prompter first so we don't leak
    // an SSE stream after switching backends.
    try {
      if (mast.prompter) {
        mast.prompter.disconnect();
        mast.prompter = null;
      }
      if (mast.client && typeof mast.client.disconnect === 'function') {
        mast.client.disconnect();
      }
      mast.client = null;
      connectionStore.setClient(null);
      connectionStore.setState('disconnected');
      setConnectionState('disconnected');
      // Clear the transcript view; a new backend means an unrelated
      // context and the outgoing session's messages shouldn't linger.
      clearTranscriptView();
    } catch (e) {
      // Best-effort teardown; log and continue with the reconnect.
      console.warn('cmdAttach teardown:', e);
    }

    // Reconnect to the new backend BEFORE persisting. If the connect
    // fails we restore the previous config so the operator isn't
    // stuck with a broken auto-connect on reload. Only on a proven-
    // working connection do we commit the new endpoint to
    // localStorage.
    let connectSucceeded = false;
    try {
      await connectToBackend(url, token);
      // connectToBackend catches its own errors and sets `connected`
      // via the connection state machine. If it didn't wire mast.client,
      // the connection failed (setConnectionState('disconnected') was
      // called + an "Connection failed" system message printed).
      connectSucceeded = !!mast.client && connected;
    } catch (e) {
      // Belt-and-suspenders — connectToBackend shouldn't rethrow, but
      // if it does we still want to reach the restore path.
      addSystemMessage('/attach failed: ' + (e.message || e));
    }

    if (!connectSucceeded) {
      // Restore the previous config so reload doesn't auto-connect
      // to the bad endpoint. If there was no previous config (fresh
      // /attach on a first-run SPA), clear it so the setup modal
      // reopens on reload rather than looping on the bad URL.
      try {
        if (prevConfig && prevConfig.endpoint) {
          setStoredConfig(prevConfig);
          addSystemMessage(
            `/attach: kept previous endpoint ${prevConfig.endpoint} — new URL didn't connect.`
          );
        } else {
          setStoredConfig(null);
          addSystemMessage('/attach: not connected — use /endpoint to reopen setup.');
        }
      } catch (e) {
        console.warn('cmdAttach restore:', e);
      }
      return;
    }

    // Only persist the new endpoint after we know it works.
    try {
      setStoredConfig({ endpoint: url, token, sessionId: initialSid || null });
    } catch (e) {
      console.warn('cmdAttach persist:', e);
    }

    if (initialSid && mast.client) {
      clearTranscriptView();
      try {
        await mast.switchSession(initialSid);
        refreshAllSidebar();
      } catch (e) {
        addSystemMessage(
          `/attach connected but /sessions/${initialSid} switch failed: ${e.message || e}`
        );
      }
    }
    addSystemMessage(`Attached to ${url}.`);
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

  document.getElementById('stop-btn').addEventListener('click', handleStopClick);

  document.getElementById('perms-modal-allow').addEventListener('click', () => {
    respondToPrompt('allow-once');
  });
  document.getElementById('perms-modal-deny').addEventListener('click', () => {
    respondToPrompt('deny');
  });

  document.getElementById('model-select').addEventListener('change', async (e) => {
    if (!connected) return;
    const model = e.target.value;
    try {
      await mast.setModel(model);
      sessionStore.setCurrentModel(model);
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

  document.getElementById('new-session-btn').addEventListener('click', async () => {
    // v0.2.0: real server-side creation via POST /sessions. Falls back
    // to a friendly message on 501 (daemon without SessionFactory) or
    // 401 (anonymous caller). The client-side stub used to just clear
    // the DOM; that lives under /clear now.
    if (!connected) {
      addSystemMessage('Not connected. Open the setup modal and connect first.');
      return;
    }
    try {
      const s = await mast.createSession();
      // Immediately switch to the newly-created session so the operator
      // can start interacting with it. Same clear+refresh cadence as
      // any other session switch so the sidebar doesn't show stale
      // state from the outgoing session.
      clearTranscriptView();
      await mast.switchSession(s.id);
      refreshAllSidebar();
      addSystemMessage(`Created session ${s.id} (owner: ${s.user || '(unknown)'}).`);
    } catch (e) {
      addSystemMessage('create session failed: ' + (e.message || e));
    }
  });
  document.getElementById('export-btn').addEventListener('click', () => cmdExport([]));

  // ─── Connection lifecycle ──────────────────────────────────────────

  async function connectToBackend(endpoint, token) {
    setConnectionState('connecting');
    try {
      await mast.init({ endpoint, token });
      setConnectionState('connected');
      addSystemMessage(`Connected to ${endpoint}.`);
      refreshAllSidebar();
    } catch (e) {
      setConnectionState('disconnected');
      addSystemMessage('Connection failed: ' + (e?.message || e));
    }
  }

  // Atomic sidebar refresh — call after any operation that switches
  // the effective session context (initial connect, switchSession,
  // createSession, deleteSession-then-fallback). Fires the model /
  // sessions / servers / specialists / identity + status bar fetches
  // in parallel so they land as close to together as possible.
  //
  // Ports the lesson from core-tui's bug #274: on session switch you
  // MUST refresh usage totals, memory, skills, MCP list, and branding
  // — not just the event stream. Otherwise the sidebar keeps
  // showing the outgoing session's data. The atomicity target here
  // is "before the next paint", not "in a single transaction"; a
  // brief flicker to empty sub-panels is acceptable.
  function refreshAllSidebar() {
    // Kick these off in parallel; each function handles its own
    // errors + DOM writes and doesn't rely on the others' results.
    updateModelSelect();
    updateSessionList();
    updateServerList();
    updateSpecialistList();
    fetchIdentity();
    updateStatusBar();
  }

  // Clear the transcript view on session switch so the outgoing
  // session's messages don't linger in the new session's view. The
  // per-turn footers, tool-call rows, etc. all belong to the old
  // session's SSE stream (already dropped by the sessionGen check in
  // dispatchAttachEvent).
  function clearTranscriptView() {
    const output = document.getElementById('output-area');
    if (output) output.innerHTML = '';
  }

  // ─── Boot ──────────────────────────────────────────────────────────

  async function boot() {
    updateBackendInfo();
    setConnectionState('disconnected');
    const cfg = getStoredConfig();
    if (cfg && cfg.endpoint) {
      await connectToBackend(cfg.endpoint, cfg.token || '');
      // If the stored endpoint failed to connect, reopen the setup
      // modal so the operator has a clear recovery path. Without this,
      // a stale bad endpoint (e.g. from a previously-successful smoke
      // run pointing at a mock that's now gone) bricks the SPA on
      // reload — connection quietly fails, no modal, and slash
      // commands used to be blocked too (fixed in this same PR).
      if (!connected) {
        addSystemMessage(
          'Auto-connect to ' +
            cfg.endpoint +
            ' failed — reopening setup so you can fix the endpoint.'
        );
        document.getElementById('setup-modal').classList.add('open');
      }
    } else {
      checkFirstRun();
    }
  }

  boot();
})();
