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

// attach-core/client — JavaScript consumer of mast / core-agent's
// attach protocol (HTTP/SSE per spec v1.2.0). Replaces the phase-A
// mock `mast` object in app.js with a real backend connection.
//
// Depends on sibling modules (loaded ahead of this file in index.html):
//   attach-core/errors.js    — PermanentStreamError
//   attach-core/protocol.js  — fanoutAgentFrame (legacy agent demux)
//
// Endpoints consumed (all under <endpoint>):
//   GET  /sessions                         → list sessions
//   GET  /sessions/{sid}/events            → SSE stream
//   POST /sessions/{sid}/inject            → queue operator prompt
//   POST /sessions/{sid}/wake              → resume agent after inject
//   POST /sessions/{sid}/interrupt         → cancel in-flight turn
//   GET  /sessions/{sid}/status            → current state snapshot
//   GET  /sessions/{sid}/tools             → registered tools
//   GET  /sessions/{sid}/agents            → registered agents
//
// SSE event types (per spec v1.2.0 §2):
//   capabilities    — first frame; protocol version + supported events
//   status-update   — model / provider / turn_state / context_pct
//   usage-update    — cumulative tokens + cost (+ last_turn since 1.1.1)
//   inbox           — queued / dequeued state for the operator prompt
//   turn-complete   — per-turn summary (tokens, latency, cost)
//                     cost_usd optional since 1.1.0 — falls through to
//                     the next usage-update.last_turn when absent.
//   turn-error      — pipeline failure (kind includes cost_ceiling)
//   agent           — legacy bundle carrying ADK session.Event payloads
//                     (text chunks, function calls, function responses
//                     all multiplexed onto this one event type). Since
//                     1.2.0, tool-result responses carry a latency_ms
//                     sidecar key inside the response map.
//
// Reserved response-body conventions (spec §slash-response, coming in
// v1.3.0; adopted here early as forward-compat):
//   _render — "text" | "markdown" | "json" (default) — chosen renderer
//   _schema — reference for schema-driven rendering (v0.3.0+)
//
// PermanentStreamError: HTTP status 404 (session gone / ACL revoked),
// 401 (token expired / revoked), or 403 (ACL revoked mid-session) are
// terminal. Everything else — 5xx, 429, transport blips — is transient
// and the reconnect loop keeps running.

window.AttachClient = (function () {
  'use strict';

  // Dependencies loaded from sibling modules; index.html loads
  // errors.js + protocol.js before this file.
  const PermanentStreamError =
    (window.AttachCoreErrors && window.AttachCoreErrors.PermanentStreamError) || null;
  const fanoutAgentFrame =
    (window.AttachCoreProtocol && window.AttachCoreProtocol.fanoutAgentFrame) || null;
  if (!PermanentStreamError || !fanoutAgentFrame) {
    throw new Error(
      'attach-core/client.js: missing dependencies — errors.js and protocol.js must load first'
    );
  }

  class AttachClient {
    constructor({ endpoint, token, sessionId, onEvent, onConnectionState }) {
      this.endpoint = endpoint.replace(/\/$/, '');
      this.token = token || '';
      this.sessionId = sessionId || '';
      this.onEvent = onEvent || (() => {});
      this.onConnectionState = onConnectionState || (() => {});
      this._sse = null;
      this._closed = false;
      // Last capabilities frame seen. Consumers read this for feature
      // detection; treat null as "backend hasn't advertised yet".
      this.capabilities = null;
    }

    // ─── HTTP helpers ────────────────────────────────────────────────

    _headers() {
      const h = { Accept: 'application/json' };
      if (this.token) {
        h['Authorization'] = 'Bearer ' + this.token;
        // X-Attach-Token is the header-alternative per #112; honor both
        // so operators on stricter proxies (where Authorization is
        // consumed mid-path) still authenticate.
        h['X-Attach-Token'] = this.token;
      }
      return h;
    }

    async _get(path) {
      const r = await fetch(this.endpoint + path, { headers: this._headers() });
      if (!r.ok) {
        const body = await r.text();
        const msg = `GET ${path} → HTTP ${r.status}: ${body}`;
        if (PermanentStreamError.isPermanentStatus(r.status)) {
          throw new PermanentStreamError(msg, r.status);
        }
        throw new Error(msg);
      }
      return r.json();
    }

    async _post(path, body) {
      const r = await fetch(this.endpoint + path, {
        method: 'POST',
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : null,
      });
      if (!r.ok) {
        const text = await r.text();
        const msg = `POST ${path} → HTTP ${r.status}: ${text}`;
        if (PermanentStreamError.isPermanentStatus(r.status)) {
          throw new PermanentStreamError(msg, r.status);
        }
        throw new Error(msg);
      }
      // /inject and /wake return small JSON envelopes; tolerate empty.
      const text = await r.text();
      return text ? JSON.parse(text) : {};
    }

    // ─── Session discovery / selection ───────────────────────────────

    async listSessions() {
      const out = await this._get('/sessions');
      return (out.sessions || []).map((s) => ({
        id: s.session_id,
        app: s.app_name,
        user: s.user_id,
        hasEventLog: !!s.has_event_log,
        label: s.session_id,
      }));
    }

    async selectSession(sessionId) {
      this.sessionId = sessionId;
      // Re-open the SSE stream for the new session if we were already
      // connected.
      if (this._sse) {
        this.disconnect();
        await this.connect();
      }
    }

    async autoSelectSession() {
      const sessions = await this.listSessions();
      if (sessions.length === 0) {
        throw new Error('no sessions available on backend (start with --session-db)');
      }
      this.sessionId = sessions[0].id;
      return sessions[0];
    }

    // ─── SSE stream ─────────────────────────────────────────────────

    async connect() {
      if (!this.sessionId) {
        await this.autoSelectSession();
      }
      this._closed = false;
      this.onConnectionState('connecting');
      // EventSource doesn't support custom headers, so when auth is
      // needed we tunnel the token as a URL query param. The server
      // accepts ?access_token=… for SSE per the attach-mode auth
      // contract (auth.go). Falls back to no-token for unauthenticated
      // dev backends.
      const tokenParam = this.token ? '?access_token=' + encodeURIComponent(this.token) : '';
      const url =
        this.endpoint + '/sessions/' + encodeURIComponent(this.sessionId) + '/events' + tokenParam;
      try {
        this._sse = new EventSource(url);
      } catch (e) {
        this.onConnectionState('disconnected');
        throw e;
      }

      this._sse.onopen = () => {
        this.onConnectionState('connected');
      };
      this._sse.onerror = () => {
        // EventSource auto-retries; report intermediate state but stay open.
        if (this._closed) return;
        this.onConnectionState('connecting');
      };

      // Typed events (spec v1.1.0 §2).
      const typed = [
        'capabilities',
        'status-update',
        'usage-update',
        'inbox',
        'turn-complete',
        'turn-error',
      ];
      typed.forEach((name) => {
        this._sse.addEventListener(name, (e) => {
          let data = null;
          try {
            data = JSON.parse(e.data);
          } catch {
            return;
          }
          // Cache the capabilities first-frame for feature detection.
          if (name === 'capabilities') this.capabilities = data;
          this.onEvent({ type: name, data });
        });
      });

      // Legacy `agent` event — Frame { seq, event } where event is an
      // ADK session.Event. Decompose into typed signals the renderer
      // expects (token / toolCall / toolResult).
      this._sse.addEventListener('agent', (e) => {
        let frame = null;
        try {
          frame = JSON.parse(e.data);
        } catch {
          return;
        }
        this._fanoutAgentFrame(frame);
      });

      // The default `message` event fires when the server sends a frame
      // without an explicit event name (shouldn't happen for typed
      // events, but the legacy fallback may). Treat the same as `agent`.
      this._sse.onmessage = (e) => {
        let frame = null;
        try {
          frame = JSON.parse(e.data);
        } catch {
          return;
        }
        if (frame && frame.event) this._fanoutAgentFrame(frame);
      };
    }

    disconnect() {
      this._closed = true;
      if (this._sse) {
        this._sse.close();
        this._sse = null;
      }
      this.onConnectionState('disconnected');
    }

    _fanoutAgentFrame(frame) {
      // Delegate to the pure helper in attach-core/protocol.js so the
      // conformance harness can exercise the same code without wiring
      // up a client. this.onEvent is the emit callback.
      fanoutAgentFrame(frame, (e) => this.onEvent(e));
    }

    // ─── Operator input ─────────────────────────────────────────────

    async inject(message) {
      return this._post('/sessions/' + encodeURIComponent(this.sessionId) + '/inject', {
        message,
      });
    }

    async wake(prompt) {
      const body = prompt ? { prompt } : {};
      return this._post('/sessions/' + encodeURIComponent(this.sessionId) + '/wake', body);
    }

    async interrupt() {
      return this._post('/sessions/' + encodeURIComponent(this.sessionId) + '/interrupt', {});
    }

    // ─── Read-only inspection ───────────────────────────────────────

    async getStatus() {
      return this._get('/sessions/' + encodeURIComponent(this.sessionId) + '/status');
    }

    async listTools() {
      const out = await this._get('/sessions/' + encodeURIComponent(this.sessionId) + '/tools');
      return out.tools || [];
    }

    async listAgents() {
      const out = await this._get('/sessions/' + encodeURIComponent(this.sessionId) + '/agents');
      return out.agents || [];
    }
  }

  // Re-export the error class as a static on the constructor so
  // callers can do `err instanceof AttachClient.PermanentStreamError`
  // without pulling in window.AttachCoreErrors directly.
  AttachClient.PermanentStreamError = PermanentStreamError;

  return AttachClient;
})();
