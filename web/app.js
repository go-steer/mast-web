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
  if (
    !window.MastState ||
    !window.MastState.session ||
    !window.MastState.connection ||
    !window.MastState.daemons
  ) {
    throw new Error(
      'MastState missing — check that web/state/*.js loaded before app.js in index.html'
    );
  }
  const sessionStore = window.MastState.session;
  const connectionStore = window.MastState.connection;
  const daemonsStore = window.MastState.daemons;

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

  // Presentation-only state: the link state last painted on the status
  // bar (the HUD strip mirrors it), and the most recent user prompt
  // (backs the per-message [RETRY] chip). Neither is protocol state,
  // so neither belongs in MastState.
  let linkState = 'disconnected';
  let lastUserPrompt = '';

  // Static markup for the boot banner, snapshotted from index.html so
  // clearTranscriptView can restore it verbatim. Empty string if the
  // banner element is absent (tests mounting a partial DOM).
  const bootBannerHTML = (() => {
    const el = document.querySelector('#output-area .boot-banner');
    return el ? el.outerHTML : '';
  })();

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
    // Observer mode: prime lastTurn from the /usage snapshot in case
    // we attached mid-stream and the SPA missed the usage-update that
    // would have populated it. Without this, the first observer-turn
    // footer's cost falls back to 0 (turn-complete.cost_usd is v1.1.0-
    // optional). Ported from coretuiremote LastTurn fallback (see
    // internal/coretuiremote/capabilities.go:180-206). Best-effort;
    // errors swallowed since a missing snapshot just means we defer
    // to the next usage-update.
    if (
      caps.features &&
      caps.features.observer_mode === true &&
      mast.client &&
      mast.client.sessionId &&
      typeof mast.client.getUsage === 'function'
    ) {
      mast.client.getUsage().then(
        (u) => {
          if (!u) return;
          const lt = u.last_turn;
          if (lt && typeof lt === 'object') {
            sessionStore.patchUsage({
              lastTurn: {
                tokensIn: lt.tokens_in || 0,
                tokensInCached: lt.tokens_in_cached || 0,
                tokensOut: lt.tokens_out || 0,
                costUSD: lt.cost_usd || 0,
                model: lt.model || '',
              },
            });
          }
        },
        () => {}
      );
    }
  }

  // Observer mode — when features.observer_mode is true, the operator
  // is attached to a session someone (or something) else is driving.
  // Show a persistent banner so an operator doesn't type into a
  // read-only stream expecting normal chat semantics.
  //
  // Two variants per features.live_agent:
  //   - read-only  (observer_mode + !live_agent): agent is autonomous;
  //     operator prompts would be no-ops (or queued indefinitely).
  //   - read-write (observer_mode + live_agent): live session — the
  //     operator's messages CAN drive the agent, but events are also
  //     visible to (and driven by) others attached to the same session.
  function applyObserverMode(features) {
    const isObserver = !!(features && features.observer_mode === true);
    const isLive = !!(features && features.live_agent === true);
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
    banner.textContent = isLive
      ? 'Live session — your messages drive the agent; events stream as they happen.'
      : 'Attached as observer — agent runs autonomously; events stream below.';
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
    renderHUD();
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

  // Multi-daemon helpers (module-scope so both mast + boot can reach).

  // Derives a short human-readable alias from a daemon endpoint URL
  // for use in the sidebar's per-daemon group header + peer tags.
  // "https://prod-daemon.internal:8080/" → "prod-daemon.internal".
  // Falls back to the URL itself on parse failure.
  function aliasFor(endpoint) {
    try {
      return new URL(endpoint).hostname || endpoint;
    } catch {
      return endpoint;
    }
  }

  function existingAddedAt(endpoint) {
    const d = daemonsStore.getDaemon(endpoint);
    return d && d.addedAt ? d.addedAt : '';
  }

  function nowISO() {
    return new Date().toISOString();
  }

  // Persistence for the multi-daemon registry — reads/writes an
  // array of {endpoint, token, alias} entries under the storage key
  // 'mast-web:daemons'. Live client/prompter refs are NOT persisted
  // (they're rebuilt on each hydrate via addDaemon-then-connect).
  //
  // Coexists with the legacy 'mast-web:config' single-entry key: on
  // first upgrade, if the daemons array is missing/empty and there's
  // a stored config, we seed the array from it. Successive writes
  // then flow through 'mast-web:daemons'.
  function getStoredDaemons() {
    try {
      const raw = localStorage.getItem('mast-web:daemons');
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function persistDaemons() {
    // Snapshot from the store (drop live refs; they don't round-trip
    // through JSON anyway). Preserves add order via listDaemons().
    const rows = daemonsStore.listDaemons().map((d) => ({
      endpoint: d.endpoint,
      token: d.token || '',
      alias: d.alias || '',
      addedAt: d.addedAt || '',
    }));
    try {
      localStorage.setItem('mast-web:daemons', JSON.stringify(rows));
    } catch (e) {
      console.warn('persistDaemons:', e);
    }
  }

  // Fire persistDaemons whenever the daemon registry changes so
  // reload picks up the latest set without callers threading persist
  // calls through every add/remove path.
  daemonsStore.store.subscribe(() => persistDaemons());

  const mast = {
    client: null,
    prompter: null,

    async init({ endpoint, token }) {
      // v0.3.0: init now wraps addDaemon — the first setup-modal add
      // is just the first entry in the multi-daemon registry. Tearing
      // down previously-active clients happens per-daemon in
      // removeDaemon; init here does NOT tear down existing daemons,
      // so a reload-triggered re-init doesn't nuke sibling daemons.
      return await this.addDaemon({ endpoint, token, makeActive: true });
    },

    // Multi-daemon core (v0.3.0 PR 2, mast-web#22):
    //
    //   addDaemon        — connect a new backend + register it. If
    //                      makeActive, swap the transcript view to it.
    //   removeDaemon     — tear down + drop from registry.
    //   switchToDaemon   — activate an already-connected daemon.
    //
    // Sidebar aggregation (updateSessionList) walks the registry and
    // renders every daemon's sessions grouped by daemon alias.

    async addDaemon({ endpoint, token, alias, makeActive }) {
      if (typeof window.AttachClient !== 'function') {
        throw new Error(
          'AttachClient global missing — check that attach-client.js loaded before app.js'
        );
      }
      if (!endpoint) throw new Error('addDaemon: endpoint required');

      // Register optimistically so the sidebar shows a "connecting"
      // row immediately. Overwritten with live refs post-connect.
      daemonsStore.addDaemon({
        endpoint,
        token: token || '',
        alias: alias || aliasFor(endpoint),
        addedAt: existingAddedAt(endpoint) || nowISO(),
        state: 'connecting',
      });

      // Per-daemon SSE dispatch: tag each event with its origin so
      // dispatchAttachEvent's multi-daemon gate can drop events from
      // non-active daemons instead of painting them into the active
      // daemon's transcript.
      const client = new window.AttachClient({
        endpoint,
        token,
        onConnectionState: (state) => {
          daemonsStore.patchDaemon(endpoint, { state });
          // Active-daemon state changes drive the global status bar;
          // background-daemon changes just update the per-row badge
          // via the sidebar re-render.
          if (daemonsStore.store.get().activeDaemon === endpoint) {
            setConnectionState(state);
          }
          updateSessionList();
        },
        onEvent: (ev) => dispatchAttachEvent({ ...ev, daemonEndpoint: endpoint }),
      });

      let session;
      try {
        session = await client.autoSelectSession();
        await client.connect();
      } catch (e) {
        daemonsStore.patchDaemon(endpoint, {
          state: 'disconnected',
          lastError: e?.message || String(e),
        });
        throw e;
      }

      daemonsStore.addDaemon({
        endpoint,
        token: token || '',
        alias: alias || aliasFor(endpoint),
        addedAt: existingAddedAt(endpoint) || nowISO(),
        state: 'connected',
        client,
      });

      if (makeActive || !daemonsStore.store.get().activeDaemon) {
        this._activateDaemon(endpoint, client, session.id);
      }
      // Populate this daemon's sessions cache in the background so
      // the sidebar can render them under this daemon's group.
      client.listSessions().then(
        (sessions) => daemonsStore.patchDaemon(endpoint, { sessions: sessions || [] }),
        () => {}
      );
      return { ok: true };
    },

    _activateDaemon(endpoint, client, sessionId) {
      // Tear down the outgoing perms stream (perms are per-session,
      // per-daemon). Do NOT tear down the outgoing client — it stays
      // alive in the background so returning to it is instant.
      if (this.prompter) {
        try {
          this.prompter.disconnect();
        } catch {
          /* best effort */
        }
        this.prompter = null;
      }
      this.client = client;
      connectionStore.setClient(client);
      connectionStore.setState('connected');
      daemonsStore.setActiveDaemon(endpoint);
      sessionStore.setCurrentSession(sessionId || '');
      openPromptStream(client.endpoint, client.token, sessionId || '');
    },

    async switchToDaemon(endpoint) {
      const d = daemonsStore.getDaemon(endpoint);
      if (!d) throw new Error(`switchToDaemon: no daemon ${endpoint}`);
      if (!d.client) throw new Error(`switchToDaemon: daemon ${endpoint} not connected`);
      if (daemonsStore.store.get().activeDaemon === endpoint) return;
      clearTranscriptView();
      // Reuse the daemon's already-selected session (its last known
      // sid on its AttachClient). If none, autoSelectSession picks
      // one; the sidebar re-renders after activation.
      const sid = d.client.sessionId || '';
      this._activateDaemon(endpoint, d.client, sid);
      refreshAllSidebar();
    },

    async removeDaemon(endpoint) {
      const d = daemonsStore.getDaemon(endpoint);
      if (!d) return;
      const wasActive = daemonsStore.store.get().activeDaemon === endpoint;
      try {
        if (d.client && typeof d.client.disconnect === 'function') d.client.disconnect();
      } catch (e) {
        console.warn('removeDaemon client teardown:', e);
      }
      if (wasActive && this.prompter) {
        try {
          this.prompter.disconnect();
        } catch {
          /* best effort */
        }
        this.prompter = null;
      }
      daemonsStore.removeDaemon(endpoint);

      if (wasActive) {
        // Hand off to the next daemon (removeDaemon set activeDaemon
        // to the earliest-added survivor already). If nothing left,
        // fall back to disconnected + setup modal.
        const next = daemonsStore.getActiveDaemon();
        if (next && next.client) {
          this._activateDaemon(next.endpoint, next.client, next.client.sessionId || '');
          refreshAllSidebar();
        } else {
          this.client = null;
          connectionStore.setClient(null);
          connectionStore.setState('disconnected');
          setConnectionState('disconnected');
          clearTranscriptView();
        }
      } else {
        // Non-active daemon dropped — just refresh the sidebar row.
        updateSessionList();
      }
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
      // /tools returns the merged tool catalog. Each entry may carry
      // explicit source/server attribution (source:'mcp', server:
      // '<name>') — prefer that when present. As of 2026-08 core-
      // agent's production adapter doesn't populate it yet for MCP
      // tools (pkg/attachadapter/capabilities.go reports source:
      // 'other' pending an upstream metadata pass), so fall back to
      // the <server>_<tool> naming convention every MCP-namespaced
      // tool still follows. This upgrades automatically once the
      // backend starts sending real attribution — no client change
      // needed then.
      const tools = await this.client.listTools();
      const byServer = new Map();
      (tools || []).forEach((t) => {
        const name = t.name || t;
        let server = t.source === 'mcp' && t.server ? t.server : null;
        if (!server) {
          const idx = name.indexOf('_');
          if (idx <= 0) return;
          server = name.substring(0, idx);
        }
        const bucket = byServer.get(server) || { name: server, status: 'connected', tools: [] };
        // Keep the full name (not stripped of its server prefix) —
        // matches how core-tui's /mcp renderer lists it, since that's
        // the name an operator would actually invoke.
        bucket.tools.push({ name, description: t.description || '' });
        byServer.set(server, bucket);
      });
      return Array.from(byServer.values());
    },

    async listTools() {
      if (!this.client) return [];
      return this.client.listTools();
    },

    // /specialists (legacy command name, kept for compat) — sourced
    // from the configured-subagent catalog (core-agent#627/#634)
    // rather than the live /agents roster: richer (model + modes) and
    // reflects what's actually spawnable, not just what has run so
    // far this session. Same underlying data as listConfiguredSubagents()
    // below (used by /subagents); shaped for the /specialists renderer.
    async listSpecialists() {
      if (!this.client) return [];
      const subs = await this.client.listConfiguredSubagents();
      return (subs || []).map((s) => ({
        name: s.name,
        description: s.description || '',
        model: s.model || '',
        modes: s.modes || [],
      }));
    },

    // Configured subagent catalog ("what's spawnable") for /subagents
    // (list + events drill-down). core-agent#627/#634.
    async listConfiguredSubagents() {
      if (!this.client) return [];
      return this.client.listConfiguredSubagents();
    },

    // Resolves `app` for the current session from the last
    // listSessions() snapshot — needed to build the qualified
    // /sessions/{app}/{sid}/agents/{name}/events path (mirrors the
    // lookup deleteSession() already does above).
    _currentApp() {
      const found = latest.sessions.find((s) => s.id === currentSession);
      return found ? found.app : '';
    },

    async getSubagentEvents(name, opts) {
      if (!this.client) throw new Error('not connected');
      const app = this._currentApp();
      if (!app) {
        throw new Error(
          `app unknown for session ${currentSession} — reload the sidebar first (/sessions list)`
        );
      }
      return this.client.getSubagentEvents(app, name, opts);
    },

    // Guardrails read/reset (core-agent#670/#671) — unblocks the
    // /reset-ceiling UX deferred in docs/v0.3-plan.md pending
    // core-agent#331 design, which has since shipped.
    async getGuardrails() {
      if (!this.client) throw new Error('not connected');
      return this.client.getGuardrails();
    },

    async resetGuardrails(opts) {
      if (!this.client) throw new Error('not connected');
      const r = await this.client.resetGuardrails(opts);
      if (r.ok) {
        // Clear the input-freezing banner state set on turn-error
        // kind=cost_ceiling; a fresh turn can now proceed normally.
        sessionStore.setCostCeilingHit(false);
      }
      return r;
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
      clearTranscriptView();
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

  // Externally-driven turn state. When the SPA is attached in observer
  // mode (or any time an event arrives without a matching runPrompt),
  // the first stream-chunk / tool-call auto-creates an observer turn so
  // the render dispatchers have somewhere to route. On turn-complete,
  // the footer is stamped + tracked in `lastObserverFooter` so a
  // subsequent usage-update.last_turn.cost_usd can back-fill the
  // authoritative cost.
  let lastObserverFooter = null;

  function beginObserverTurn() {
    // Mirror the render callbacks submitPrompt uses so observer events
    // paint into the transcript identically to operator-driven ones.
    // Closure over `streaming` + `pendingToolEls` keeps per-turn state
    // hidden here rather than leaking module-scope.
    let streaming = null;
    const pendingToolEls = [];
    const startedAt = performance.now();
    // Externally-driven turns get the same activity chrome as
    // operator-driven ones — an observer should be able to tell at a
    // glance that the agent is mid-turn.
    setTurnActive(true);

    const turn = {
      observer: true,
      callbacks: {
        onToken: (token) => {
          if (!streaming) streaming = createStreamingMessage();
          updateStreamingMessage(streaming, token);
        },
        onToolCall: (server, tool) => {
          streaming = null;
          pendingToolEls.push(addToolPendingMessage(server, tool));
        },
        onToolResult: (server, tool, latencyMs, errMsg, resultJSON) => {
          const el = pendingToolEls.shift();
          completeToolMessage(el, latencyMs, errMsg, resultJSON);
        },
        onSearchQueries: (queries) => {
          streaming = null;
          addBuiltinToolMessage('🔍 Search', Array.from(queries));
        },
        onURLFetch: (urls) => {
          streaming = null;
          addBuiltinToolMessage('🌐 URL fetched', Array.from(urls));
        },
        onGrounding: (claims, sources) => {
          injectCitations(streaming, Array.from(claims || []), Array.from(sources || []));
        },
      },
      startedAt,
      done: false,
      finish(result) {
        if (this.done) return;
        this.done = true;
        connectionStore.setActiveTurn(null);
        setTurnActive(false);
        if (result) {
          const el = addTurnFooter(result);
          lastObserverFooter = el;
          sessionStore.incrementTurnCount();
          updateStatusBar();
        }
        // Safety net: any pending tool indicators without a matching
        // result get marked as "turn ended".
        pendingToolEls.forEach((el) => completeToolMessage(el, 0, 'turn ended', ''));
      },
    };
    connectionStore.setActiveTurn(turn);
    return turn;
  }

  // ─── SSE event → renderer dispatch ─────────────────────────────────

  // Pairs onToolCall → onToolResult: each tool call pushes its
  // function-call ID; the matching tool-result pops by ID so out-of-
  // order completions still pair correctly (defensive — backends
  // typically emit in order).
  const pendingToolCallsByID = new Map();

  function dispatchAttachEvent(ev) {
    // Multi-daemon gate — the SPA holds SSE connections to every
    // added daemon; only the active daemon's events should paint the
    // transcript. Non-active daemons' events still fire (their
    // AttachClient is live) but drop here so switching daemons
    // doesn't interleave transcripts. Aggregate state (session list,
    // per-daemon status) is refreshed via explicit polling from the
    // sidebar renderer, not from SSE. Ported from coretuiremote's
    // active-peer routing (internal/coretuiremote/capabilities.go).
    const activeEP = daemonsStore.store.get().activeDaemon;
    if (ev.daemonEndpoint && activeEP && ev.daemonEndpoint !== activeEP) {
      return;
    }
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
          // If a footer got stamped ahead of the priced-out cost (the
          // usual case for turn-complete-then-usage-update ordering),
          // back-fill it in place. Idempotent — no-op if already set.
          backfillTurnFooter(lastObserverFooter, usagePatch.lastTurn.costUSD);
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
        // Empty turn (no activeTurn AND no stream-chunk / tool-call
        // rendered): nothing to footer. Skip silently.
        return;
      }

      case 'turn-error': {
        const te = ev.data || {};
        const msg = `${te.kind || 'error'}: ${te.message || ''}${te.hint ? ' (' + te.hint + ')' : ''}`;
        // v1.2.0 kind=cost_ceiling — session refuses further turns until
        // a reset (server-side reset UX shipped core-agent#670/#671).
        // No matching turn-complete will follow.
        if (te.kind === 'cost_ceiling') {
          sessionStore.setCostCeilingHit(true);
          addSystemMessage(
            'Cost ceiling reached — session paused. Run /guardrails reset to clear it ' +
              '(requires GuardrailAdmin), or /guardrails for details.'
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
        // Suppress the prompt echo. A real backend replays the prompt
        // the model received as a user-authored agent frame ahead of
        // the reply — [Inbox] wrapper and all — so rendering it puts
        // the operator's own message inside the agent bubble. The
        // filter belongs here rather than in fanoutAgentFrame: those
        // fixtures are a cross-implementation spec contract shared
        // with core-agent's coretuiremote adapter, so the wire
        // decomposition stays faithful and the renderer decides what
        // to draw. Fixture 006 pins the shape.
        if (ev.data.author === 'user') return;
        let turn = activeTurn;
        // Externally-driven turn: if events arrive without an
        // activeTurn (peer-observed / observer-mode / autonomous
        // session running while we attach mid-stream), spawn an
        // observer turn so we render everything we see rather than
        // silently dropping it. Matches coretuiremote's peer-observer
        // rendering behavior. observer_mode capability still gates
        // the banner variant, but the render path itself is not
        // capability-gated.
        if (!turn) turn = beginObserverTurn();
        if (!turn || !turn.callbacks.onToken) return;
        turn.callbacks.onToken(ev.data.text);
        return;
      }

      case 'tool-call': {
        if (ev.replay) return; // historical tool call, not for this session's view
        let turn = activeTurn;
        if (!turn) turn = beginObserverTurn();
        if (!turn || !turn.callbacks.onToolCall) return;
        const { id, name } = ev.data;
        const idx = name.indexOf('_');
        const server = idx > 0 ? name.substring(0, idx) : '';
        const tool = idx > 0 ? name.substring(idx + 1) : name;
        turn.callbacks.onToolCall(server, tool);
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

  // Wall-clock stamp for transcript rows: `14:02:15`. Local time —
  // the operator correlates these against their own logs and their
  // own clock, not against the daemon's.
  function nowStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // `ROLE: [hh:mm:ss]` header shared by user + assistant rows.
  function makeMsgHead(role) {
    const head = document.createElement('div');
    head.className = 'msg-head';
    const r = document.createElement('span');
    r.className = 'msg-role';
    r.textContent = role + ':';
    const t = document.createElement('span');
    t.className = 'msg-time';
    t.textContent = '[' + nowStamp() + ']';
    head.appendChild(r);
    head.appendChild(t);
    return head;
  }

  function addMessage(role, content, extraClass) {
    const div = document.createElement('div');
    div.className = 'message ' + role + (extraClass ? ' ' + extraClass : '');
    if (role === 'assistant') {
      div.appendChild(makeMsgHead('AGENT'));
      const md = document.createElement('div');
      md.className = 'md-content';
      md.innerHTML = renderMarkdown(content);
      div.appendChild(md);
      addMessageActions(div, content);
    } else if (role === 'user') {
      div.appendChild(makeMsgHead('USER'));
      const body = document.createElement('div');
      body.className = 'msg-body';
      body.textContent = content;
      div.appendChild(body);
    } else {
      div.dataset.ts = nowStamp();
      div.textContent = content;
    }
    outputArea.appendChild(div);
    outputArea.scrollTop = outputArea.scrollHeight;
    return div;
  }

  // Bracketed [COPY] [RETRY] chips under an assistant row. `getText`
  // is a thunk because a streaming row's final text isn't known when
  // the chips are attached.
  function addMessageActions(el, textOrGetter) {
    const text = () => (typeof textOrGetter === 'function' ? textOrGetter() : textOrGetter);
    const row = document.createElement('div');
    row.className = 'msg-actions';

    const copy = document.createElement('button');
    copy.className = 'msg-action';
    copy.textContent = 'COPY';
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

    const retry = document.createElement('button');
    retry.className = 'msg-action';
    retry.textContent = 'RETRY';
    retry.title = 'Re-send the prompt that produced this response';
    retry.addEventListener('click', () => {
      if (!lastUserPrompt || isRunning) return;
      submitPrompt(lastUserPrompt);
    });

    row.appendChild(copy);
    row.appendChild(retry);
    el.appendChild(row);
  }

  // cmdOutput distinguishes genuine built-in command output (/help,
  // /stats, /mcp, /guardrails, ...) from transient connection/status
  // notices ("Not connected", "Session cleared.") — the former gets
  // the accented .cmd-output treatment (see styles.css), the latter
  // stays a plain muted log line.
  function addSystemMessage(text, cmdOutput) {
    addMessage('system', text, cmdOutput ? 'cmd-output' : '');
  }

  // Insert a system message whose body is pre-rendered HTML. Used by
  // the generic server-slash dispatcher so responses can flow through
  // SlashRender's markdown / json / text renderers, and by the /mcp,
  // /tools, /specialists, /subagents renderListHTML() output. Always
  // command output. Contents come from SlashRender or renderListHTML,
  // both of which HTML-escape their inputs — do NOT feed arbitrary
  // user or server strings here without sanitization.
  function addSystemMessageHTML(html) {
    const div = document.createElement('div');
    div.className = 'message system cmd-output';
    div.dataset.ts = nowStamp();
    div.innerHTML = html;
    outputArea.appendChild(div);
    outputArea.scrollTop = outputArea.scrollHeight;
  }

  // Renders a per-turn footer + returns the element so a later
  // usage-update.last_turn can back-fill the authoritative cost
  // (turn-complete.cost_usd is v1.1.0-optional; the SPA doesn't know
  // whether the incoming zero is "no cost" or "not yet computed" until
  // last_turn arrives with the server-priced number).
  function addTurnFooter(result) {
    const div = document.createElement('div');
    div.className = 'turn-footer';
    div.dataset.totalMs = String(result.totalMs || 0);
    div.dataset.tokensIn = String(result.tokens.in || 0);
    div.dataset.tokensOut = String(result.tokens.out || 0);
    div.dataset.costUsd = String(result.costUSD || 0);
    renderTurnFooter(div);
    outputArea.appendChild(div);
    outputArea.scrollTop = outputArea.scrollHeight;
    return div;
  }

  // Renders a footer's visible text from its data-* attributes. Split
  // out so backfillTurnFooter can update the same element idempotently.
  function renderTurnFooter(el) {
    const totalMs = Number(el.dataset.totalMs) || 0;
    const tIn = Number(el.dataset.tokensIn) || 0;
    const tOut = Number(el.dataset.tokensOut) || 0;
    const cost = Number(el.dataset.costUsd) || 0;
    const parts = [`${(totalMs / 1000).toFixed(2)}s`, `${tIn}↑ / ${tOut}↓ tokens`];
    if (cost > 0) parts.push('$' + cost.toFixed(6));
    // The ::before/::after hairlines are drawn in CSS; the element's
    // own text is just the metrics between them.
    el.textContent = parts.join('  ·  ');
  }

  // Back-fills a stamped footer's cost once the authoritative
  // usage-update.last_turn arrives. No-op if the new cost matches
  // what's already displayed (prevents flicker on double-fires).
  function backfillTurnFooter(el, costUSD) {
    if (!el || typeof costUSD !== 'number' || costUSD <= 0) return;
    const prev = Number(el.dataset.costUsd) || 0;
    if (prev === costUSD) return;
    el.dataset.costUsd = String(costUSD);
    renderTurnFooter(el);
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

    // Keep the sources strip above the action chips, which were
    // appended when the streaming row was created.
    const actions = streamingRef.el.querySelector('.msg-actions');
    streamingRef.el.insertBefore(stripContainer, actions);
    outputArea.scrollTop = outputArea.scrollHeight;
  }

  function addBuiltinToolMessage(label, items) {
    items.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'message builtin-tool';
      const ts = document.createElement('span');
      ts.className = 'tool-ts';
      ts.textContent = '[' + nowStamp() + ']';
      div.appendChild(ts);
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
    div.appendChild(makeMsgHead('AGENT'));
    const md = document.createElement('div');
    md.className = 'md-content';
    div.appendChild(md);
    outputArea.appendChild(div);
    const ref = { el: div, md: md, text: '' };
    // Chips read the accumulated text at click time — the row is
    // still streaming when they're attached.
    addMessageActions(div, () => ref.text);
    return ref;
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

  // Formats a caught error for a system-message line. Special-cases
  // BackendDrainingError (503 shutdown drain, core-agent#564/#567)
  // with a friendlier, actionable message instead of the raw dump
  // other errors get.
  function describeError(e, prefix = 'Error: ') {
    const Drain = window.AttachClient && window.AttachClient.BackendDrainingError;
    if (Drain && e instanceof Drain) {
      return e.retryAfterSeconds
        ? `Backend is restarting — retry in ~${e.retryAfterSeconds}s.`
        : 'Backend is restarting — retry shortly.';
    }
    return prefix + (e && e.message ? e.message : e);
  }

  // One-line summary of a persisted subagent turn event (same ADK
  // Event shape as the SSE `agent` frame) for the /subagents events
  // drill-down. Reuses the pure fanoutAgentFrame parser rather than
  // re-deriving Content/parts field-variant handling.
  function summarizeAgentEvent(event) {
    if (!window.AttachCoreProtocol) return '(event)';
    const parts = [];
    window.AttachCoreProtocol.fanoutAgentFrame({ event }, (e) => parts.push(e));
    if (parts.length === 0) return '(empty)';
    return parts
      .map((p) => {
        if (p.type === 'stream-chunk') return `text: ${p.data.text.slice(0, 80)}`;
        if (p.type === 'tool-call') return `call ${p.data.name}`;
        if (p.type === 'tool-result') return `result ${p.data.name} (${p.data.latencyMs}ms)`;
        return p.type;
      })
      .join('; ');
  }

  // Builds an HTML system-message block for a titled, optionally
  // grouped list (MCP servers → their tools; a flat tool/specialist
  // roster). Each item renders as a bulleted name line (+ dim tag
  // suffix) with its description indented below — matches core-tui's
  // renderToolList/renderMCPServers shape instead of the single-line-
  // per-item text /mcp and /tools used to collapse into. Feed to
  // addSystemMessageHTML; all fields are escaped here.
  //
  // groups: [{ header?: string, items: [{ name, tags?: string[], description?: string }] }]
  function renderListHTML(title, groups) {
    const parts = [`<div class="list-title">${escapeHtml(title)}</div>`];
    groups.forEach((g) => {
      if (g.header) {
        parts.push(`<div class="list-group-header">${escapeHtml(g.header)}</div>`);
      }
      if (g.items.length === 0) {
        parts.push('<div class="list-item-desc">(none)</div>');
        return;
      }
      g.items.forEach((it) => {
        const tags =
          it.tags && it.tags.length
            ? ` <span class="list-item-tags">[${escapeHtml(it.tags.join(', '))}]</span>`
            : '';
        parts.push(
          `<div class="list-item">` +
            `<div class="list-item-name">▸ ${escapeHtml(it.name)}${tags}</div>` +
            (it.description
              ? `<div class="list-item-desc">${escapeHtml(it.description)}</div>`
              : '') +
            `</div>`
        );
      });
    });
    return parts.join('');
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

  // Bumped on every updateSessionList entry. The refetch below is
  // async, so two overlapping calls (onConnectionState + a concurrent
  // refreshAllSidebar, say) would each clear the container and then
  // each append a full set of groups — the sidebar would show every
  // session twice. The loser bails at the generation check instead.
  let sessionListGen = 0;

  async function updateSessionList() {
    const container = document.getElementById('session-list');
    if (!container) return;
    const gen = ++sessionListGen;
    container.innerHTML = '';

    const daemons = daemonsStore.listDaemons();
    const activeEP = daemonsStore.store.get().activeDaemon;
    if (daemons.length === 0) {
      container.innerHTML =
        '<div style="font-size:11px;color:var(--text-dim)">No daemons connected</div>';
      return;
    }

    // Fire per-daemon session-list refetch in parallel so the sidebar
    // reflects the most recent server state. Uses each daemon's own
    // client (not mast.client), so a background daemon's sessions
    // still refresh even when it's not active.
    await Promise.all(
      daemons.map((d) => {
        if (!d.client || typeof d.client.listSessions !== 'function') return Promise.resolve();
        return d.client.listSessions().then(
          (sessions) => daemonsStore.patchDaemon(d.endpoint, { sessions: sessions || [] }),
          (e) => daemonsStore.patchDaemon(d.endpoint, { lastError: e?.message || String(e) })
        );
      })
    );

    // A newer render started while we were refetching — it owns the
    // container now; appending here would duplicate its rows.
    if (gen !== sessionListGen) return;

    // Re-read daemon list after refetch so we render the latest
    // session arrays.
    container.innerHTML = '';
    daemonsStore.listDaemons().forEach((d) => {
      renderDaemonGroup(container, d, activeEP);
    });
  }

  // One <div class="daemon-group"> per daemon. Header shows the
  // daemon's alias + state badge + × remove button. Body lists each
  // session (or "no sessions"). The active daemon's group renders
  // without any peer badge; non-active daemons' sessions get a
  // [peer:<alias>] tag on the row.
  function renderDaemonGroup(container, d, activeEP) {
    const isActive = d.endpoint === activeEP;
    const group = document.createElement('div');
    group.className = 'daemon-group';

    const header = document.createElement('div');
    header.className = 'daemon-header';
    const alias = d.alias || aliasFor(d.endpoint);
    const stateBadge = `<span class="status ${escapeHtml(d.state || 'disconnected')}">${escapeHtml(d.state || 'disconnected')}</span>`;
    const peerBadge = isActive
      ? '<span class="daemon-peer-badge active">active</span>'
      : '<span class="daemon-peer-badge">peer</span>';
    header.innerHTML =
      '<span class="daemon-alias" title="' +
      escapeHtml(d.endpoint) +
      '">' +
      escapeHtml(alias) +
      '</span> ' +
      peerBadge +
      ' ' +
      stateBadge;
    header.style.cursor = 'pointer';
    // Click header to make this daemon active (no-op if already).
    header.onclick = async () => {
      if (isActive) return;
      try {
        await mast.switchToDaemon(d.endpoint);
        addSystemMessage(`Switched to daemon ${alias} (${d.endpoint}).`);
      } catch (e) {
        addSystemMessage('daemon switch failed: ' + (e.message || e));
      }
    };
    // × removes the daemon (with confirm to guard against fat-finger).
    // Only shown when there's more than one daemon so the operator
    // can't accidentally strand the SPA with an empty registry via
    // this button (they can still use /endpoint to fully reset).
    if (daemonsStore.listDaemons().length > 1) {
      const rm = document.createElement('button');
      rm.className = 'remove-btn';
      rm.textContent = '×';
      rm.title = 'Remove daemon';
      rm.onclick = async (evt) => {
        evt.stopPropagation();
        if (!window.confirm(`Remove daemon ${alias} (${d.endpoint})?`)) return;
        try {
          await mast.removeDaemon(d.endpoint);
          addSystemMessage(`Removed daemon ${alias}.`);
        } catch (e) {
          addSystemMessage('remove failed: ' + (e.message || e));
        }
      };
      header.appendChild(rm);
    }
    group.appendChild(header);

    const sessions = d.sessions || [];
    if (sessions.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:4px 8px';
      empty.textContent = 'No sessions';
      group.appendChild(empty);
    } else {
      sessions.forEach((s) => group.appendChild(renderSessionRow(d, s, isActive)));
    }

    container.appendChild(group);
  }

  function renderSessionRow(d, s, isActive) {
    const activeSid = latest.currentSession;
    const rowActive = isActive && s.id === activeSid;
    const item = document.createElement('div');
    item.className = 'server-item';
    if (rowActive) item.classList.add('active');

    const info = document.createElement('div');
    const statusText = s.status === 'idle' ? 'idle' : '';
    const badge = statusText
      ? `<span class="status ${escapeHtml(s.status)}" title="lazy-resumes on attach">${escapeHtml(statusText)}</span>`
      : '';
    info.innerHTML = `<span class="name">${escapeHtml(s.label || s.id)}</span> ${badge}`;
    info.style.cursor = 'pointer';
    info.onclick = async () => {
      if (rowActive) return;
      try {
        clearTranscriptView();
        if (!isActive) {
          // Cross-daemon jump — activate the daemon first, then
          // switch to the target session on it.
          await mast.switchToDaemon(d.endpoint);
        }
        await mast.switchSession(s.id);
        refreshAllSidebar();
        addSystemMessage(`Switched to session ${s.id}.`);
      } catch (e) {
        addSystemMessage('switch failed: ' + (e.message || e));
      }
    };
    item.appendChild(info);

    if (s.id !== 'default') {
      const del = document.createElement('button');
      del.className = 'remove-btn';
      del.textContent = '×';
      del.title = 'Delete session';
      del.onclick = async (evt) => {
        evt.stopPropagation();
        if (!window.confirm(`Delete session "${s.id}" on ${d.alias || d.endpoint}?`)) return;
        try {
          // Delete on the owning daemon's client (not necessarily
          // the active one) — but our mast.deleteSession assumes
          // the active client. Route via the daemon's client
          // directly for cross-daemon deletes.
          if (!d.client) throw new Error('daemon not connected');
          await d.client.deleteSession(s.app, s.id);
          addSystemMessage(`Deleted session ${s.id}.`);
          daemonsStore.patchDaemon(d.endpoint, {
            sessions: (d.sessions || []).filter((x) => x.id !== s.id),
          });
          updateSessionList();
        } catch (e) {
          addSystemMessage('delete failed: ' + (e.message || e));
        }
      };
      item.appendChild(del);
    }

    return item;
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
        const toolsLine =
          (s.tools || []).length > 0
            ? `<br><span class="status" style="color:var(--text-dim)">${escapeHtml(
                s.tools.map((t) => t.name).join(', ')
              )}</span>`
            : '';
        info.innerHTML =
          `<span class="name">${escapeHtml(s.name)}</span><br>` +
          `<span class="status ${statusClass}">${escapeHtml(s.status || 'unknown')}</span>` +
          toolsLine;
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
        const tagBits = [];
        if (s.model) tagBits.push(s.model);
        if (s.modes && s.modes.length) tagBits.push(s.modes.join('/'));
        const tagLine = tagBits.length
          ? `<br><span class="item-tags">${escapeHtml(tagBits.join(', '))}</span>`
          : '';
        // .item-desc / .item-tags, not .status — the state chips wear
        // brackets and neither a description nor a model name is a state.
        info.innerHTML =
          `<span class="name">${escapeHtml(s.name)}</span><br>` +
          `<span class="item-desc">${escapeHtml(s.description || '').slice(0, 60)}</span>` +
          tagLine;
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
    linkState = state === 'connected' || state === 'connecting' ? state : 'disconnected';
    const el = document.getElementById('status-connection');
    if (!el) return;
    el.classList.remove('connected', 'connecting', 'disconnected');
    el.classList.add(state);
    const label =
      state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting…' : 'disconnected';
    el.textContent = `⬤ ${label}`;
    renderHUD();
  }

  function updateBackendInfo() {
    const cfg = getStoredConfig();
    const el = document.getElementById('backend-info');
    if (!el) return;
    el.textContent = cfg && cfg.endpoint ? cfg.endpoint : 'Not configured';
  }

  function updateStatusBar() {
    document.getElementById('status-model').textContent = 'Model: ' + (currentModel || '—');
    // Session lives on the HUD strip's CONTEXT slot, not here.
    document.getElementById('status-turns').textContent = 'Turns: ' + turnCount;
    document.getElementById('status-cost').textContent = '$' + totalCostUSD.toFixed(2);
    renderHUD();
  }

  // ─── HUD strip ─────────────────────────────────────────────────────
  //
  // The header answers "who am I talking to, and where" — agent,
  // link state, session. Live telemetry (turns / cost / elapsed)
  // deliberately stays on #status-bar; splitting them this way keeps
  // either strip from having to re-render on every token.

  function renderHUD() {
    const header = document.getElementById('chat-header');
    if (!header) return;

    const caps = latest.capabilities || {};
    const agent = caps.agent || {};
    const cfg = getStoredConfig();
    const agentName =
      agent.name || caps.server || (cfg && cfg.endpoint ? aliasFor(cfg.endpoint) : '') || '—';
    setText('hud-agent', agentName);

    // linkState mirrors what setConnectionState last painted on the
    // status bar. Reading connectionStore here instead would drift:
    // not every setConnectionState call has a matching store write
    // (the 'connecting' transitions don't).
    header.classList.remove('connected', 'connecting', 'disconnected');
    header.classList.add(linkState);
    setText(
      'hud-status',
      linkState === 'connected' ? 'ONLINE' : linkState === 'connecting' ? 'LINKING' : 'OFFLINE'
    );

    setText('hud-context', '[' + (currentSession || 'no session') + ']');
    setText('hud-activity', isRunning ? 'WORKING' : 'IDLE');
    renderPromptPrefix();
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // Shell prefix on the prompt line: `[session] ~>`. Falls back to the
  // product name before a session exists.
  function renderPromptPrefix() {
    const el = document.getElementById('prompt-prefix');
    if (!el) return;
    el.textContent = '[' + (currentSession || 'mast') + '] ~>';
  }

  // Body-level flag driving the activity sweep + HUD "WORKING" label.
  function setTurnActive(active) {
    document.body.classList.toggle('turn-active', !!active);
    setText('hud-activity', active ? 'WORKING' : 'IDLE');
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
    lastUserPrompt = text;
    setTurnActive(true);
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
      lastObserverFooter = addTurnFooter(result);
      sessionStore.incrementTurnCount();
      updateStatusBar();
    } catch (e) {
      addSystemMessage(describeError(e));
    } finally {
      thinking.stop();
      stopElapsedTimer();
      // safety net: mark any orphaned pending indicators as failed
      pendingToolEls.forEach((el) => completeToolMessage(el, 0, 'turn ended', ''));
      pendingToolEls.length = 0;
      connectionStore.setIsRunning(false);
      setTurnActive(false);
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
      addSystemMessage(describeError(e, 'interrupt failed: '));
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
    '/tools': cmdTools,
    '/specialists': cmdSpecialists,
    '/subagents': cmdSubagents,
    '/guardrails': cmdGuardrails,
    '/stats': cmdStats,
    '/batch': cmdBatch,
    '/export': cmdExport,
    '/clear': cmdClear,
    '/whoami': cmdWhoami,
    '/endpoint': cmdEndpoint,
    '/attach': cmdAttach,
    '/theme': cmdTheme,
    '/layout': cmdLayout,
  };

  // Theme picker (v0.3.0 PR 7, mast-web#27). Themes are CSS-variable
  // overrides applied via <body data-theme="…">. Persisted in
  // localStorage under the key 'mast-web:theme' so a reload keeps
  // the operator's choice. All theme rules live in web/styles.css
  // (search for /* Themes */ header).
  const THEMES = [
    { id: 'default', label: 'Default (Go brand, dark)' },
    { id: 'solarized-dark', label: 'Solarized Dark' },
    { id: 'solarized-light', label: 'Solarized Light' },
    { id: 'high-contrast', label: 'High Contrast (WCAG AAA)' },
    { id: 'mono', label: 'Monochrome' },
    { id: 'paper', label: 'Paper (soft light)' },
  ];

  function applyTheme(id) {
    const known = THEMES.find((t) => t.id === id);
    const chosen = known ? id : 'default';
    if (chosen === 'default') {
      document.body.removeAttribute('data-theme');
    } else {
      document.body.setAttribute('data-theme', chosen);
    }
    try {
      localStorage.setItem('mast-web:theme', chosen);
    } catch {
      /* ignore quota errors */
    }
  }

  function currentTheme() {
    return document.body.getAttribute('data-theme') || 'default';
  }

  function cmdTheme(args) {
    if (args.length === 0) {
      const cur = currentTheme();
      const list = THEMES.map((t) => `${t.id === cur ? '> ' : '  '}${t.id.padEnd(18)} ${t.label}`);
      addSystemMessage('Themes:\n' + list.join('\n') + '\n\nUsage: /theme <id>', true);
      return;
    }
    const id = args[0].toLowerCase();
    const known = THEMES.find((t) => t.id === id);
    if (!known) {
      addSystemMessage(`Unknown theme "${id}". /theme with no args to list.`);
      return;
    }
    applyTheme(id);
    addSystemMessage('Theme: ' + id);
  }

  // Layout picker — orthogonal to /theme (color) and independently
  // switchable. Two transcript layouts:
  //   log (default) — everything left-aligned as a terminal log, with
  //                   `USER:`/`AGENT: [hh:mm:ss]` heads per row.
  //   chat          — user turns right-aligned, chat-bubble style.
  // The console restyle made log the house style, so log is the
  // attribute-less default and chat is the opt-in; before that the
  // polarity was reversed. Applied via <body data-layout="…">, same
  // mechanism as /theme's data-theme. Persisted in localStorage under
  // 'mast-web:layout'. CSS lives in web/styles.css (search /* Layouts */).
  const LAYOUTS = [
    { id: 'log', label: 'Log (left-aligned terminal transcript)' },
    { id: 'chat', label: 'Chat (right-aligned user turns)' },
  ];

  function applyLayout(id) {
    const known = LAYOUTS.find((l) => l.id === id);
    const chosen = known ? id : 'log';
    if (chosen === 'log') {
      document.body.removeAttribute('data-layout');
    } else {
      document.body.setAttribute('data-layout', chosen);
    }
    try {
      localStorage.setItem('mast-web:layout', chosen);
    } catch {
      /* ignore quota errors */
    }
  }

  function currentLayout() {
    return document.body.getAttribute('data-layout') || 'log';
  }

  function cmdLayout(args) {
    if (args.length === 0) {
      const cur = currentLayout();
      const list = LAYOUTS.map((l) => `${l.id === cur ? '> ' : '  '}${l.id.padEnd(18)} ${l.label}`);
      addSystemMessage('Layouts:\n' + list.join('\n') + '\n\nUsage: /layout <id>', true);
      return;
    }
    const id = args[0].toLowerCase();
    const known = LAYOUTS.find((l) => l.id === id);
    if (!known) {
      addSystemMessage(`Unknown layout "${id}". /layout with no args to list.`);
      return;
    }
    applyLayout(id);
    addSystemMessage('Layout: ' + id);
  }

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
        addSystemMessage(JSON.stringify(res, null, 2), true);
      }
    } catch (e) {
      addSystemMessage('/' + name + ' failed: ' + (e.message || e));
    }
  }

  function cmdHelp() {
    const localCommands = [
      '/help              — Show this help',
      '/attach <url> [<token>] [<sid>]  — Add a backend daemon (existing daemons stay connected)',
      '/model [name]      — List or switch model',
      '/sessions [list|switch <id>]  — Manage sessions',
      '/mcp list          — Show MCP servers + their tools (backend-configured; read-only)',
      '/tools             — Show the flat registered-tool catalog',
      '/specialists list  — Show registered specialists',
      '/subagents [events <name> [since]]  — Configured subagent catalog / turn drill-down',
      '/guardrails [reset [watchdog|cost_ceiling|all] [budget]]  — Watchdog + cost-ceiling status/reset',
      '/stats             — Show session stats',
      '/batch             — Open batch panel',
      '/export [fmt]      — Export session (json|md)',
      '/clear             — Clear current session messages',
      '/whoami            — Show backend identity',
      '/endpoint          — Reconfigure backend endpoint',
      '/theme [id]        — List or switch themes',
      '/layout [id]       — List or switch transcript layout (chat|log)',
      '',
      'Press Ctrl+/ (Cmd+/ on macOS) to see all keyboard shortcuts.',
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
    addSystemMessage(helpText, true);
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
      addSystemMessage('Models:\n' + list, true);
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
      addSystemMessage('Sessions:\n' + list, true);
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
      const groups = servers.map((s) => ({
        header: `${s.name} — ${s.status}`,
        items: (s.tools || []).map((t) => ({ name: t.name, description: t.description })),
      }));
      addSystemMessageHTML(renderListHTML('MCP servers', groups));
    } else {
      addSystemMessage(
        'MCP server lifecycle is backend-controlled. /mcp list shows what the backend has configured.'
      );
    }
  }

  // /tools — flat registered-tool catalog (GET /sessions/{sid}/tools).
  // Distinct from /mcp list, which buckets the same catalog by MCP
  // server; this is the ungrouped view, annotated with each tool's
  // source classification and permission gate state where the
  // backend provides them.
  async function cmdTools(_args) {
    if (!connected) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    try {
      const tools = await mast.listTools();
      if (!tools || tools.length === 0) {
        addSystemMessage('No tools registered on the backend.');
        return;
      }
      const items = tools.map((t) => {
        const tags = [];
        if (t.source) tags.push(t.source === 'mcp' && t.server ? t.server : t.source);
        if (t.gate_state) tags.push(t.gate_state);
        return { name: t.name || t, tags, description: t.description };
      });
      addSystemMessageHTML(renderListHTML(`Tools (${items.length})`, [{ items }]));
    } catch (e) {
      addSystemMessage(describeError(e));
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
    const items = specs.map((s) => {
      const tags = [];
      if (s.model) tags.push(s.model);
      if (s.modes && s.modes.length) tags.push(s.modes.join('/'));
      return { name: s.name, tags, description: s.description };
    });
    addSystemMessageHTML(renderListHTML('Specialists', [{ items }]));
  }

  // /subagents [list]              — configured subagent catalog
  // /subagents events <name> [since] — a subagent's persisted turns
  // (core-agent#627/#634 catalog + #638/#687 drill-down).
  async function cmdSubagents(args) {
    if (!connected) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    const sub = (args[0] || 'list').toLowerCase();
    if (sub === 'events') {
      const name = args[1];
      if (!name) {
        addSystemMessage('Usage: /subagents events <name> [since]');
        return;
      }
      const since = args[2] !== undefined ? Number(args[2]) : undefined;
      try {
        const out = await mast.getSubagentEvents(name, {
          since: Number.isFinite(since) ? since : undefined,
        });
        const events = out.events || [];
        if (events.length === 0) {
          addSystemMessage(`No persisted events for subagent "${name}" yet.`);
          return;
        }
        // Preview the tail — pagination further back is available via
        // the `since` arg once next_since is known.
        const preview = events
          .slice(-10)
          .map((e) => `  #${e.seq} ${summarizeAgentEvent(e.event)}`)
          .join('\n');
        addSystemMessage(
          `Subagent "${name}" — ${events.length} event(s)` +
            ` (next_since=${out.next_since}${out.truncated ? ', truncated' : ''}):\n` +
            preview,
          true
        );
      } catch (e) {
        addSystemMessage(describeError(e));
      }
      return;
    }
    try {
      const subs = await mast.listConfiguredSubagents();
      if (!subs || subs.length === 0) {
        addSystemMessage('No subagents configured on the backend.');
        return;
      }
      const items = subs.map((s) => ({
        name: s.name,
        tags: s.modes && s.modes.length ? [s.modes.join('/')] : [],
        description: s.description,
      }));
      addSystemMessageHTML(
        renderListHTML('Configured subagents', [{ items }]) +
          '<div class="list-item-desc" style="margin-top:8px">Usage: /subagents events &lt;name&gt; [since]</div>'
      );
    } catch (e) {
      addSystemMessage(describeError(e));
    }
  }

  // /guardrails                              — show watchdog + cost-ceiling state
  // /guardrails reset [watchdog|cost_ceiling|all] [budget-usd]  — reset
  // (core-agent#670/#671; unblocks the /reset-ceiling non-goal in
  // docs/v0.3-plan.md).
  async function cmdGuardrails(args) {
    if (!connected) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    if ((args[0] || '').toLowerCase() === 'reset') {
      const guardrail = args[1] || undefined;
      const budget = args[2] !== undefined ? Number(args[2]) : undefined;
      try {
        const r = await mast.resetGuardrails({
          guardrail,
          additionalBudgetUsd: Number.isFinite(budget) ? budget : undefined,
        });
        if (r.ok) {
          addSystemMessage(
            'Guardrails reset: ' +
              (r.reset && r.reset.length ? r.reset.join(', ') : '(nothing tripped)'),
            true
          );
        } else {
          addSystemMessage(
            r.message ||
              'Reset would immediately re-trip — pass a budget: /guardrails reset cost_ceiling <usd>',
            true
          );
        }
      } catch (e) {
        addSystemMessage(describeError(e, 'guardrails reset failed: '));
      }
      return;
    }
    try {
      const g = await mast.getGuardrails();
      const w = g.watchdog || {};
      const c = g.cost_ceiling || {};
      addSystemMessage(
        `Guardrails:\n` +
          `  Watchdog:      mode=${w.mode || 'off'} tripped=${!!w.tripped}` +
          `${w.reason ? ' (' + w.reason + ')' : ''}\n` +
          `  Cost ceiling:  $${(c.session_cost_usd || 0).toFixed(2)} / ` +
          `$${(c.max_session_usd || 0).toFixed(2)} tripped=${!!c.tripped}` +
          `${c.reason ? ' (' + c.reason + ')' : ''}\n` +
          `  Halted:        ${!!g.halted}\n\n` +
          `Usage: /guardrails reset [watchdog|cost_ceiling|all] [additional-budget-usd]`,
        true
      );
    } catch (e) {
      addSystemMessage(describeError(e));
    }
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
          `  Avg total:   ${s.avgTotalMs.toFixed(0)}ms`,
        true
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
    clearTranscriptView();
    await mast.clearSession();
    sessionStore.store.set({ turnCount: 0, totalCostUSD: 0 });
    addSystemMessage('Session cleared.');
    updateStatusBar();
  }

  async function cmdWhoami() {
    try {
      const info = await mast.fetchIdentity();
      addSystemMessage(
        `Identity:\n  Email:   ${info.email || '(unknown)'}\n  Source:  ${info.source || '(unknown)'}`,
        true
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

  // /attach <url> [<token>] [<sid>] — v0.3.0: add-daemon (not swap-
  // daemon). Existing daemons stay connected; the new one joins the
  // registry and becomes active. Sidebar aggregates sessions across
  // all daemons; each row is tagged with its owning daemon.
  //
  // Removes v0.2.0's "one daemon at a time" constraint. Cross-daemon
  // session switch is instant now — no reconnect on hop.
  async function cmdAttach(args) {
    const url = args[0];
    if (!url) {
      addSystemMessage(
        'Usage: /attach <url> [<token>] [<sid>]  —  add a backend daemon (existing daemons stay connected)'
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

    // Guard against duplicate adds — re-attaching an already-added
    // daemon just switches to it instead of tearing down and rebuild.
    if (daemonsStore.getDaemon(url)) {
      try {
        await mast.switchToDaemon(url);
        addSystemMessage(`/attach: switched to already-added daemon ${url}.`);
      } catch (e) {
        addSystemMessage('/attach switch failed: ' + (e.message || e));
      }
      return;
    }

    addSystemMessage(`Adding daemon ${url}${initialSid ? ' (session ' + initialSid + ')' : ''}...`);

    try {
      await mast.addDaemon({ endpoint: url, token, makeActive: true });
    } catch (e) {
      addSystemMessage('/attach failed: ' + (e?.message || e));
      return;
    }

    if (initialSid) {
      clearTranscriptView();
      try {
        await mast.switchSession(initialSid);
      } catch (e) {
        addSystemMessage(
          `/attach connected but /sessions/${initialSid} switch failed: ${e.message || e}`
        );
      }
    }
    refreshAllSidebar();
    addSystemMessage(`Attached to ${url}. (${daemonsStore.listDaemons().length} daemon(s) total.)`);
  }

  // ─── Batch run ─────────────────────────────────────────────────────
  //
  // Sequential real-backend runner: for each prompt, injects +
  // waits for turn-complete via mast.runPrompt, capturing per-turn
  // {latencyMs, tokens, cost, ttfbMs}. Rows render incrementally as
  // each turn resolves — the operator sees progress instead of
  // waiting for the whole batch to finish before the table paints.
  //
  // Cancellation halts before the next prompt; the in-flight turn
  // is left to complete (interrupting mid-turn requires the agent's
  // Interrupt capability, which we don't want to entangle with
  // batch semantics for v0.3.0).

  let batchData = [];
  let batchCancelToken = null;
  const sortDir = {};

  document.getElementById('batch-run-btn').addEventListener('click', async () => {
    if (!connected) {
      addSystemMessage('Not connected to a backend');
      return;
    }
    if (batchCancelToken) {
      addSystemMessage('A batch run is already in flight — use Stop first.');
      return;
    }
    const input = document.getElementById('batch-input').value.trim();
    if (!input) return;
    const prompts = input.split('\n').filter((l) => l.trim());
    if (prompts.length === 0) return;

    const runBtn = document.getElementById('batch-run-btn');
    const stopBtn = document.getElementById('batch-stop-btn');
    runBtn.disabled = true;
    stopBtn.hidden = false;
    batchCancelToken = { cancelled: false };
    // Snapshot the token here so a subsequent "Run Batch" click
    // that resets batchCancelToken doesn't break this run's guard.
    const myCancel = batchCancelToken;

    // Seed the entries with pending rows so the table renders
    // immediately with the shape of the whole run. Each row flips
    // to done / error / cancelled as its turn resolves.
    const entries = prompts.map((p) => ({ prompt: p, status: 'pending' }));
    batchData = entries;
    renderBatchTable(entries, null);
    updateBatchProgress(0, entries.length);
    document.getElementById('batch-progress').hidden = false;

    let done = 0;
    for (let i = 0; i < prompts.length; i++) {
      if (myCancel.cancelled) {
        for (let j = i; j < prompts.length; j++) {
          entries[j].status = 'cancelled';
        }
        break;
      }
      const p = prompts[i];
      entries[i].status = 'running';
      renderBatchTable(entries, null);
      try {
        const startedAt = performance.now();
        let firstEventAt = 0;
        const r = await mast.runPrompt(p, {
          onToken: () => {
            if (!firstEventAt) firstEventAt = performance.now();
          },
          onToolCall: () => {
            if (!firstEventAt) firstEventAt = performance.now();
          },
        });
        const ttfbMs = firstEventAt ? firstEventAt - startedAt : r.totalMs;
        entries[i] = {
          prompt: p,
          status: 'done',
          result: {
            totalMs: r.totalMs,
            ttfbMs,
            tokens: r.tokens || { in: 0, out: 0 },
            costUSD: typeof r.costUSD === 'number' ? r.costUSD : 0,
            toolCalls: r.toolCalls || [],
          },
        };
      } catch (e) {
        entries[i] = {
          prompt: p,
          status: 'error',
          error: e?.message || String(e),
        };
      }
      done = i + 1;
      updateBatchProgress(done, entries.length);
      renderBatchTable(entries, null);
    }

    // Final summary — same stats block the header table shows.
    const okEntries = entries.filter((e) => e.status === 'done');
    const stats = okEntries.length
      ? {
          totalTurns: okEntries.length,
          totalTokenIn: okEntries.reduce((s, e) => s + e.result.tokens.in, 0),
          totalTokenOut: okEntries.reduce((s, e) => s + e.result.tokens.out, 0),
          totalCostUSD: okEntries.reduce((s, e) => s + (e.result.costUSD || 0), 0),
          avgTtfbMs: okEntries.reduce((s, e) => s + e.result.ttfbMs, 0) / okEntries.length,
          avgTotalMs: okEntries.reduce((s, e) => s + e.result.totalMs, 0) / okEntries.length,
        }
      : null;
    renderBatchTable(entries, stats);
    stopBtn.hidden = true;
    runBtn.disabled = false;
    batchCancelToken = null;
  });

  document.getElementById('batch-stop-btn').addEventListener('click', () => {
    if (!batchCancelToken) return;
    batchCancelToken.cancelled = true;
    // The current in-flight turn will still complete. Stop is only
    // meaningful as "don't kick off the next prompt".
    addSystemMessage('Batch stop requested — halting after current in-flight prompt.');
  });

  function updateBatchProgress(done, total) {
    const wrap = document.getElementById('batch-progress');
    const text = document.getElementById('batch-progress-text');
    const bar = document.querySelector('#batch-progress-bar span');
    if (!wrap || !text || !bar) return;
    text.textContent = `${done} of ${total} done`;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    bar.style.width = pct + '%';
  }

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
    html += '<th data-sort="costUSD">Cost ($)</th>';
    html += '<th>Status</th>';
    html += '</tr></thead><tbody>';
    entries.forEach((e) => {
      html += '<tr>';
      html += `<td>${escapeHtml(e.prompt.slice(0, 60))}</td>`;
      const status = e.status || (e.error ? 'error' : e.result ? 'done' : 'pending');
      if (status === 'error') {
        html += `<td colspan="6" style="color:var(--red)">${escapeHtml(e.error || '')}</td>`;
        html += '<td style="color:var(--red)">Error</td>';
      } else if (status === 'done') {
        const r = e.result;
        html += `<td>${r.totalMs.toFixed(0)}</td>`;
        html += `<td>${r.ttfbMs.toFixed(0)}</td>`;
        html += `<td>${(r.toolCalls || []).length}</td>`;
        html += `<td>${r.tokens.in}</td>`;
        html += `<td>${r.tokens.out}</td>`;
        html += `<td>${(r.costUSD || 0).toFixed(6)}</td>`;
        html += '<td style="color:var(--green)">OK</td>';
      } else if (status === 'running') {
        html += `<td colspan="6" style="color:var(--brand-yellow)">running…</td>`;
        html += '<td style="color:var(--brand-yellow)">Running</td>';
      } else if (status === 'cancelled') {
        html += `<td colspan="6" style="color:var(--text-dim)">skipped (Stop)</td>`;
        html += '<td style="color:var(--text-dim)">Cancelled</td>';
      } else {
        html += `<td colspan="6" style="color:var(--text-dim)">pending</td>`;
        html += '<td style="color:var(--text-dim)">Pending</td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table>';
    if (batchStats) {
      html +=
        `<div style="margin-top:8px;font-size:11px;color:var(--text-dim)">` +
        `Summary: ${batchStats.totalTurns} completed, ` +
        `${batchStats.totalTokenIn} in / ${batchStats.totalTokenOut} out tokens, ` +
        `$${batchStats.totalCostUSD.toFixed(6)} total, ` +
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
      } else if (!a.result || !b.result) {
        // Rows without a result (error / pending / running / cancelled)
        // sink to the bottom in either direction — a stable "unrated"
        // block keeps the table readable during a streaming run.
        return !a.result ? 1 : -1;
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
        } else if (field === 'costUSD') {
          va = ra.costUSD || 0;
          vb = rb.costUSD || 0;
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
    let csv = 'Prompt,Total (ms),TTFB (ms),Tool Calls,Tokens In,Tokens Out,Cost (USD),Status\n';
    batchData.forEach((e) => {
      const prompt = '"' + e.prompt.replace(/"/g, '""') + '"';
      const status = e.status || (e.error ? 'error' : e.result ? 'done' : 'pending');
      if (status === 'error') {
        const msg = (e.error || '').replace(/,/g, ';');
        csv += `${prompt},,,,,,,Error: ${msg}\n`;
      } else if (status === 'done') {
        const r = e.result;
        csv +=
          `${prompt},${r.totalMs.toFixed(0)},${r.ttfbMs.toFixed(0)},` +
          `${(r.toolCalls || []).length},${r.tokens.in},${r.tokens.out},` +
          `${(r.costUSD || 0).toFixed(6)},OK\n`;
      } else if (status === 'cancelled') {
        csv += `${prompt},,,,,,,Cancelled\n`;
      } else {
        csv += `${prompt},,,,,,,${status}\n`;
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
  const promptShell = document.getElementById('prompt-shell');

  // .has-text hides the decorative idle block cursor once there's
  // something in the field (see #prompt-caret in styles.css).
  function syncPromptShell() {
    if (promptShell) promptShell.classList.toggle('has-text', promptInput.value.length > 0);
  }

  function resetPromptInput() {
    promptInput.value = '';
    promptInput.style.height = 'auto';
    syncPromptShell();
  }

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitPrompt(promptInput.value);
      resetPromptInput();
    }
  });

  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
    syncPromptShell();
  });

  sendBtn.addEventListener('click', () => {
    submitPrompt(promptInput.value);
    resetPromptInput();
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
    if (!output) return;
    // Re-seed the boot banner so a cleared screen reads as a fresh
    // terminal rather than a blank void. bootBannerHTML is captured
    // from the served markup at boot (see below).
    output.innerHTML = bootBannerHTML;
  }

  // ─── Keyboard shortcuts (v0.3.0 PR 7, mast-web#27) ────────────────
  //
  // Modifier is Ctrl on Linux/Windows, Cmd on Mac. Bindings are
  // hardcoded — rebindable shortcuts are v0.4+ work. All shortcuts
  // are documented in the Ctrl+/ overlay.

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const MOD_LABEL = isMac ? 'Cmd' : 'Ctrl';

  // Table of shortcuts — rendered into the shortcuts overlay and
  // driven by installKeyboardShortcuts. `test` returns true when the
  // event matches; `action` runs the binding.
  const SHORTCUTS = [
    {
      key: `${MOD_LABEL}+K`,
      description: 'Open session picker (fuzzy-match across all daemons)',
      test: (e) => modKey(e) && e.key.toLowerCase() === 'k',
      action: () => openSessionPicker(),
    },
    {
      key: `${MOD_LABEL}+P`,
      description: 'Open command palette (fuzzy-match slash commands)',
      test: (e) => modKey(e) && e.key.toLowerCase() === 'p',
      action: () => openCommandPalette(),
    },
    {
      key: `${MOD_LABEL}+Enter`,
      description: 'Submit prompt (bypasses Shift+Enter for newline)',
      test: (e) => modKey(e) && e.key === 'Enter',
      action: () => document.getElementById('send-btn')?.click(),
    },
    {
      key: `${MOD_LABEL}+B`,
      description: 'Toggle sidebar collapse',
      test: (e) => modKey(e) && e.key.toLowerCase() === 'b',
      action: () => document.body.classList.toggle('sidebar-collapsed'),
    },
    {
      key: `${MOD_LABEL}+/`,
      description: 'Show this keyboard-shortcuts overlay',
      test: (e) => modKey(e) && e.key === '/',
      action: () => openShortcutsOverlay(),
    },
    {
      key: '/',
      description: 'Focus prompt input + start typing a slash command',
      // Only fires when nothing else is focused (i.e. body has focus).
      test: (e) => e.key === '/' && !isEditableFocused() && !anyModalOpen(),
      action: () => {
        const input = document.getElementById('prompt-input');
        if (!input) return;
        input.focus();
        // Insert the '/' the operator just typed so it doesn't get
        // eaten by the focus jump. The default keydown handler would
        // also insert it, but we've prevented that in the wrapper.
        input.value = input.value + '/';
        // Move cursor to end.
        input.selectionStart = input.selectionEnd = input.value.length;
      },
    },
    {
      key: 'Esc',
      description: 'Close any open modal / overlay / batch panel',
      test: (e) => e.key === 'Escape' && anyModalOpen(),
      action: () => closeAllModals(),
    },
  ];

  function modKey(e) {
    return isMac ? e.metaKey : e.ctrlKey;
  }

  function isEditableFocused() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  function anyModalOpen() {
    return !!document.querySelector('.modal-overlay.open, #batch-panel.open');
  }

  function closeAllModals() {
    document.querySelectorAll('.modal-overlay.open').forEach((el) => el.classList.remove('open'));
    document.getElementById('batch-panel')?.classList.remove('open');
  }

  function installKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Skip everything if this is a repeat — modifiers + letter
      // held down shouldn't spam the palette open.
      if (e.repeat) return;
      for (const s of SHORTCUTS) {
        if (s.test(e)) {
          e.preventDefault();
          try {
            s.action();
          } catch (err) {
            console.warn('shortcut action failed:', err);
          }
          return;
        }
      }
    });

    // Wire the shortcuts-overlay close button.
    document.getElementById('shortcuts-close')?.addEventListener('click', () => {
      document.getElementById('shortcuts-modal').classList.remove('open');
    });

    // Command palette wiring — input filters + Enter runs the top match.
    const paletteInput = document.getElementById('palette-input');
    paletteInput?.addEventListener('input', () => refreshPaletteList(paletteInput.value));
    paletteInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = document.querySelector('#palette-list .palette-item');
        if (first) {
          e.preventDefault();
          first.click();
        }
      }
    });

    // Session picker wiring — same shape as palette.
    const pickerInput = document.getElementById('picker-input');
    pickerInput?.addEventListener('input', () => refreshPickerList(pickerInput.value));
    pickerInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = document.querySelector('#picker-list .palette-item');
        if (first) {
          e.preventDefault();
          first.click();
        }
      }
    });
  }

  function openShortcutsOverlay() {
    const tbody = document.querySelector('#shortcuts-table tbody');
    if (tbody) {
      tbody.innerHTML = SHORTCUTS.map(
        (s) =>
          `<tr><td style="padding:4px 8px;color:var(--brand-yellow);white-space:nowrap"><kbd>${escapeHtml(s.key)}</kbd></td>` +
          `<td style="padding:4px 8px">${escapeHtml(s.description)}</td></tr>`
      ).join('');
    }
    document.getElementById('shortcuts-modal').classList.add('open');
  }

  function openCommandPalette() {
    const modal = document.getElementById('palette-modal');
    const input = document.getElementById('palette-input');
    if (!modal || !input) return;
    input.value = '';
    refreshPaletteList('');
    modal.classList.add('open');
    setTimeout(() => input.focus(), 0);
  }

  function refreshPaletteList(query) {
    const list = document.getElementById('palette-list');
    if (!list) return;
    const q = query.trim().toLowerCase().replace(/^\//, '');
    const local = Object.keys(slashCommands).map((cmd) => ({ name: cmd.slice(1), src: 'local' }));
    const serverNames = (latest.capabilities && latest.capabilities.slash_commands) || [];
    const server = serverNames.map((n) => ({ name: n, src: 'server' }));
    const all = local.concat(server);
    const matches = q ? all.filter((c) => fuzzyMatch(c.name, q)).slice(0, 20) : all.slice(0, 20);
    list.innerHTML = matches
      .map(
        (c) =>
          `<div class="palette-item" data-cmd="${escapeHtml(c.name)}">` +
          `<span class="palette-cmd">/${escapeHtml(c.name)}</span>` +
          `<span class="palette-src">${escapeHtml(c.src)}</span></div>`
      )
      .join('');
    list.querySelectorAll('.palette-item').forEach((el) => {
      el.addEventListener('click', () => {
        document.getElementById('palette-modal').classList.remove('open');
        const input = document.getElementById('prompt-input');
        if (input) {
          input.value = '/' + el.dataset.cmd + ' ';
          input.focus();
          input.selectionStart = input.selectionEnd = input.value.length;
        }
      });
    });
  }

  function openSessionPicker() {
    const modal = document.getElementById('picker-modal');
    const input = document.getElementById('picker-input');
    if (!modal || !input) return;
    input.value = '';
    refreshPickerList('');
    modal.classList.add('open');
    setTimeout(() => input.focus(), 0);
  }

  function refreshPickerList(query) {
    const list = document.getElementById('picker-list');
    if (!list) return;
    // Aggregate sessions across every registered daemon (multi-daemon
    // from PR 2). Each row remembers its owning daemon so Enter can
    // dispatch to the right client.
    const rows = [];
    daemonsStore.listDaemons().forEach((d) => {
      (d.sessions || []).forEach((s) => {
        rows.push({
          daemon: d,
          session: s,
          label: `${s.label || s.id}  [${d.alias || aliasFor(d.endpoint)}]`,
        });
      });
    });
    const q = query.trim().toLowerCase();
    const matches = q
      ? rows.filter((r) => fuzzyMatch(r.label.toLowerCase(), q)).slice(0, 30)
      : rows.slice(0, 30);
    list.innerHTML = matches
      .map(
        (r, idx) =>
          `<div class="palette-item" data-idx="${idx}">` +
          `<span class="palette-cmd">${escapeHtml(r.session.label || r.session.id)}</span>` +
          `<span class="palette-src">${escapeHtml(r.daemon.alias || aliasFor(r.daemon.endpoint))}</span></div>`
      )
      .join('');
    list.querySelectorAll('.palette-item').forEach((el) => {
      el.addEventListener('click', async () => {
        const r = matches[Number(el.dataset.idx)];
        if (!r) return;
        document.getElementById('picker-modal').classList.remove('open');
        try {
          clearTranscriptView();
          if (daemonsStore.store.get().activeDaemon !== r.daemon.endpoint) {
            await mast.switchToDaemon(r.daemon.endpoint);
          }
          await mast.switchSession(r.session.id);
          refreshAllSidebar();
        } catch (e) {
          addSystemMessage('picker switch failed: ' + (e.message || e));
        }
      });
    });
  }

  // Cheap fuzzy match: every char in query must appear in name in
  // order (not necessarily contiguous). Good enough for a small
  // command list; if we grow to 100s of commands, revisit with a
  // scoring model. Case-insensitive; assumes both args lowercased.
  function fuzzyMatch(name, query) {
    let i = 0;
    for (const c of name) {
      if (c === query[i]) i++;
      if (i === query.length) return true;
    }
    return false;
  }

  // ─── Boot ──────────────────────────────────────────────────────────

  async function boot() {
    // Apply persisted theme before any paint so there's no flash of
    // default palette on reload. If nothing's persisted, applyTheme
    // falls through to 'default' + writes it back (harmless).
    try {
      applyTheme(localStorage.getItem('mast-web:theme') || 'default');
    } catch {
      applyTheme('default');
    }
    try {
      applyLayout(localStorage.getItem('mast-web:layout') || 'log');
    } catch {
      applyLayout('log');
    }
    installKeyboardShortcuts();

    updateBackendInfo();
    setConnectionState('disconnected');

    // v0.3.0: hydrate the full daemon registry from localStorage.
    // On upgrade from a v0.2.x SPA the daemons array may be empty
    // but the legacy single-daemon config is present; seed the
    // array from it so the reload experience is seamless.
    let daemonsList = getStoredDaemons();
    if (daemonsList.length === 0) {
      const cfg = getStoredConfig();
      if (cfg && cfg.endpoint) {
        daemonsList = [
          {
            endpoint: cfg.endpoint,
            token: cfg.token || '',
            alias: aliasFor(cfg.endpoint),
            addedAt: nowISO(),
          },
        ];
      }
    }

    if (daemonsList.length === 0) {
      checkFirstRun();
      return;
    }

    // Fan-out: connect every daemon in parallel. First-successful-
    // in-order becomes active (matches the operator's mental model —
    // the primary daemon they added first is the one that surfaces
    // on reload). Failed connects stay in the registry with state=
    // 'disconnected' + lastError so they render in the sidebar (with
    // an X button to remove or an implicit retry on next reload).
    const results = await Promise.all(
      daemonsList.map((row, idx) =>
        mast
          .addDaemon({
            endpoint: row.endpoint,
            token: row.token || '',
            alias: row.alias || aliasFor(row.endpoint),
            makeActive: idx === 0,
          })
          .then(
            () => ({ ok: true, endpoint: row.endpoint }),
            (e) => ({ ok: false, endpoint: row.endpoint, err: e })
          )
      )
    );

    const oks = results.filter((r) => r.ok).length;
    const fails = results.filter((r) => !r.ok);
    if (fails.length > 0) {
      addSystemMessage(
        `Auto-connected ${oks}/${results.length} daemon(s). Failed: ${fails
          .map((f) => f.endpoint)
          .join(', ')}. Use /attach to retry or × in the sidebar to remove.`
      );
    }

    // If nothing connected and we have no active daemon, reopen the
    // setup modal so the operator can recover. Otherwise the SPA
    // would sit at "disconnected" with no obvious path forward.
    if (oks === 0) {
      document.getElementById('setup-modal').classList.add('open');
    }
  }

  boot();
})();
