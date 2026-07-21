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
// attach protocol (HTTP/SSE per spec v1.4.0). Replaces the phase-A
// mock `mast` object in app.js with a real backend connection.
//
// Version note: v1.3.0 was consumed 2026-07-17 by the digest-`savings`
// sidecar. v1.4.0 (core-agent#344 + core-tui#68, both merged
// 2026-07-20) added the capabilities-frame extensions this client
// consumes (features / slash_commands / agent / caller_id +
// status-update.capabilities merge) plus the /whoami endpoint +
// slash-response `_render` / `_schema` reserved keys.
//
// Depends on sibling modules (loaded ahead of this file in index.html):
//   attach-core/errors.js    — PermanentStreamError
//   attach-core/protocol.js  — fanoutAgentFrame (legacy agent demux)
//   attach-core/replay.js    — ReplayFilter (attach cutoff)
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
// SSE event types (per spec v1.4.0 §2):
//   capabilities    — first frame; protocol_version + event_types +
//                     server + (since 1.4.0) features / slash_commands
//                     / agent / caller_id. Consumers cache the whole
//                     frame on client.capabilities.
//   status-update   — model / provider / turn_state / context_pct.
//                     Since 1.4.0, may carry an optional `capabilities`
//                     field for hot changes (merge semantics — merge
//                     into stored capabilities, don't replace).
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
// Reserved response-body conventions (spec §6, v1.4.0):
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
  // errors.js + protocol.js + replay.js before this file.
  const PermanentStreamError =
    (window.AttachCoreErrors && window.AttachCoreErrors.PermanentStreamError) || null;
  const fanoutAgentFrame =
    (window.AttachCoreProtocol && window.AttachCoreProtocol.fanoutAgentFrame) || null;
  const ReplayFilter = (window.AttachCoreReplay && window.AttachCoreReplay.ReplayFilter) || null;
  if (!PermanentStreamError || !fanoutAgentFrame || !ReplayFilter) {
    throw new Error(
      'attach-core/client.js: missing dependencies — errors.js, protocol.js, and replay.js must load first'
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
      // Session generation counter — bumps on connect() / selectSession()
      // / any SSE stream restart. Every emitted event carries the gen
      // at emit time via the `gen` field so consumers can drop stale
      // events after a switch. Ported concept from core-tui's
      // agentcmd.go:229 (sessionGen uint64 drop-on-mismatch pattern).
      this.sessionGen = 0;
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
      // v1.1.0+: response also carries `status` ('active'|'idle') and
      // `last_touched_at` (ISO string). Expose both so the sidebar
      // can render an idle badge + sort by recency.
      return (out.sessions || []).map((s) => ({
        id: s.session_id,
        app: s.app_name,
        user: s.user_id,
        hasEventLog: !!s.has_event_log,
        status: s.status || 'active',
        lastTouchedAt: s.last_touched_at || null,
        label: s.session_id,
      }));
    }

    // ─── Session create / delete (new in v0.2.0) ────────────────────

    // POST /sessions — creates an owned session for the authenticated
    // caller. Returns { app, user, sessionID, url }. Throws:
    //   401 → authenticated caller required (no anon sessions)
    //   409 → sid collision (factory generator bug)
    //   501 → daemon has no SessionFactory configured
    // See core-agent pkg/attach/handlers_create_session.go.
    async createSession() {
      const res = await this._post('/sessions', {});
      return {
        id: res.sessionID || res.session_id || '',
        app: res.app || res.app_name || '',
        user: res.user || res.user_id || '',
        url: res.url || '',
      };
    }

    // DELETE /sessions/{app}/{sid} — hard-deletes a session. 204 on
    // success; 403 on the bootstrap `default` session; SessionAdmin
    // required. All SSE subscribers see channel-close EOF.
    // See core-agent pkg/attach/handlers_delete_session.go.
    async deleteSession(app, sid) {
      const path = '/sessions/' + encodeURIComponent(app) + '/' + encodeURIComponent(sid);
      const r = await fetch(this.endpoint + path, {
        method: 'DELETE',
        headers: this._headers(),
      });
      if (!r.ok && r.status !== 204) {
        const text = await r.text();
        const msg = `DELETE ${path} → HTTP ${r.status}: ${text}`;
        if (PermanentStreamError.isPermanentStatus(r.status)) {
          throw new PermanentStreamError(msg, r.status);
        }
        throw new Error(msg);
      }
      return true;
    }

    async selectSession(sessionId) {
      this.sessionId = sessionId;
      // Re-open the SSE stream for the new session if we were already
      // connected. connect() bumps sessionGen so stale events in
      // flight from the previous stream get dropped by consumers.
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
      // Bump the generation counter so events from an in-flight prior
      // stream (still draining after the operator hit switch mid-
      // response) get dropped by consumer-side gen checks.
      this.sessionGen += 1;
      // Fresh replay filter per connection. The server may re-stream
      // the full eventlog before switching to live tail; frames with
      // Timestamp < (connectedAt - grace) are classified as replay
      // and consumers suppress them from the transcript view.
      this._replayFilter = new ReplayFilter({});
      this.onConnectionState('connecting');
      // EventSource doesn't support custom headers, so when auth is
      // needed we tunnel the token as a URL query param. The server
      // accepts ?access_token=… for SSE per the attach-mode auth
      // contract (auth.go). Falls back to no-token for unauthenticated
      // dev backends.
      //
      // Also forward any ?fixture=<name> present on the SPA's own
      // URL. The smoke-test mock backend switches fixtures on this
      // query — letting an operator reload with
      // https://.../?fixture=002-cost-ceiling-mid-turn hits the mock's
      // scenario switch without restarting `make smoke`. Real backends
      // ignore unknown query params, so this is safe as a pass-through.
      const params = new URLSearchParams();
      if (this.token) params.set('access_token', this.token);
      try {
        if (typeof window !== 'undefined' && window.location && window.location.search) {
          const spaQuery = new URLSearchParams(window.location.search);
          const fixture = spaQuery.get('fixture');
          if (fixture) params.set('fixture', fixture);
        }
      } catch {
        /* ignore — non-browser or restricted environment */
      }
      const qs = params.toString();
      const url =
        this.endpoint +
        '/sessions/' +
        encodeURIComponent(this.sessionId) +
        '/events' +
        (qs ? '?' + qs : '');
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
      // Capture the generation at listener-registration time so events
      // arriving after a selectSession() bump are tagged with the OLD
      // gen and consumers can drop them.
      const streamGen = this.sessionGen;
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
          this.onEvent({ type: name, data, gen: streamGen });
        });
      });

      // Legacy `agent` event — Frame { seq, event } where event is an
      // ADK session.Event. Decompose into typed signals the renderer
      // expects (token / toolCall / toolResult). Each fanned-out
      // sub-event is tagged with the stream generation so post-switch
      // stragglers can be dropped by consumers, and with `replay:
      // true` when the server-provided Timestamp puts it before the
      // connection cutoff (broadcaster replay flood suppression).
      const replayFilter = this._replayFilter;
      this._sse.addEventListener('agent', (e) => {
        let frame = null;
        try {
          frame = JSON.parse(e.data);
        } catch {
          return;
        }
        const ts = ReplayFilter.extractAgentFrameTimestamp(frame);
        const isReplay = replayFilter ? replayFilter.isReplay(ts) : false;
        this._fanoutAgentFrame(frame, streamGen, isReplay);
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
        if (frame && frame.event) this._fanoutAgentFrame(frame, streamGen);
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

    _fanoutAgentFrame(frame, gen, replay) {
      // Delegate to the pure helper in attach-core/protocol.js so the
      // conformance harness can exercise the same code without wiring
      // up a client. this.onEvent is the emit callback.
      //
      // Every fanned-out sub-event is tagged with:
      //   gen    — stream generation at emit-time (see connect()).
      //            Consumers drop mismatched gens to prevent stale-
      //            event bleed after a switch.
      //   replay — true when the source frame's server timestamp puts
      //            it before the connection cutoff (broadcaster
      //            replay-flood). Consumers suppress replay events
      //            from the transcript view but still update
      //            aggregate state (usage totals, etc.).
      const g = typeof gen === 'number' ? gen : this.sessionGen;
      const r = replay === true;
      fanoutAgentFrame(frame, (e) => this.onEvent({ ...e, gen: g, replay: r }));
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

    // POST /sessions/{sid}/interrupt — cancels the current in-flight
    // turn (if any). Returns a structured shape rather than raw JSON
    // so UI code can distinguish:
    //   { ok: true, interrupted: 'yes' }              — active turn cancelled
    //   { ok: true, interrupted: 'nothing-in-flight'} — 200 + X-Interrupted
    //                                                   header (session idle)
    //   { ok: false, unsupported: true }              — 412 (agent has no
    //                                                   InterruptProvider
    //                                                   capability). UI should
    //                                                   disable the Stop button.
    // Other errors propagate as thrown Error / PermanentStreamError.
    async interrupt() {
      const path = '/sessions/' + encodeURIComponent(this.sessionId) + '/interrupt';
      const r = await fetch(this.endpoint + path, {
        method: 'POST',
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (r.status === 412) {
        // Agent doesn't implement InterruptProvider. Not an error
        // condition — just tells the caller to hide the affordance.
        return { ok: false, unsupported: true };
      }
      if (!r.ok) {
        const text = await r.text();
        const msg = `POST ${path} → HTTP ${r.status}: ${text}`;
        if (PermanentStreamError.isPermanentStatus(r.status)) {
          throw new PermanentStreamError(msg, r.status);
        }
        throw new Error(msg);
      }
      // X-Interrupted: nothing-in-flight (a v1.1.0+ signal) tells us
      // the session was already idle; the button press is a no-op
      // that should give brief feedback but not surface an error.
      const flag = r.headers.get('X-Interrupted') || '';
      return {
        ok: true,
        interrupted: flag === 'nothing-in-flight' ? 'nothing-in-flight' : 'yes',
      };
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

    // GET /sessions/{sid}/usage — cumulative-usage snapshot including
    // the same last_turn payload the usage-update SSE frame carries.
    // Used by the observer-mode footer-stamping path (v0.3.0 PR 3) to
    // back-fill the first turn's per-turn cost when the SPA attaches
    // mid-stream and misses the usage-update that would have primed
    // lastTurn (coretuiremote LastTurn fallback pattern; see
    // core-agent/internal/coretuiremote/capabilities.go:180-206).
    async getUsage() {
      return this._get('/sessions/' + encodeURIComponent(this.sessionId) + '/usage');
    }

    // GET /whoami — session-agnostic caller identity endpoint (v1.4.0+).
    // Returns { identity, admin, source, proxy_by } where:
    //   source ∈ { bearer, mtls, iap, asserted, anonymous }
    //   proxy_by  — set when the caller was asserted via a proxy
    //               allowlist (X-Asserted-Caller); identifies the
    //               proxy for audit / display ("alice via bot").
    //               Empty string when not proxied.
    // Standard middleware still runs — a bearer-required listener
    // 401s an unauthenticated /whoami like any other route.
    async whoami() {
      return this._get('/whoami');
    }
  }

  // Re-export the error class as a static on the constructor so
  // callers can do `err instanceof AttachClient.PermanentStreamError`
  // without pulling in window.AttachCoreErrors directly.
  AttachClient.PermanentStreamError = PermanentStreamError;

  return AttachClient;
})();
