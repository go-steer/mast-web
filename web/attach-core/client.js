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
// attach protocol (HTTP/SSE per spec v1.12.0). Replaces the phase-A
// mock `mast` object the phase-A shell carried with a real backend
// connection.
//
// Version note: v1.3.0 was consumed 2026-07-17 by the digest-`savings`
// sidecar. v1.4.0 (core-agent#344 + core-tui#68, both merged
// 2026-07-20) added the capabilities-frame extensions this client
// consumes (features / slash_commands / agent / caller_id +
// status-update.capabilities merge) plus the /whoami endpoint +
// slash-response `_render` / `_schema` reserved keys.
//
// 2026-08-14 sync: added guardrails read/reset (core-agent#670/#671,
// unblocks the /reset-ceiling non-goal from mast-web docs/v0.3-plan.md),
// the configured-subagent catalog (core-agent#627/#634), the subagent
// turn drill-down (core-agent#638/#687), and BackendDrainingError for
// 503 + Retry-After on shutdown drain (core-agent#564/#567).
//
// 2026-09-12 sync (docs/upstream-drift-2026-09-12.md): the protocol had
// moved 1.4.0 → 1.7.0 in three bumps while this file stayed at 1.4.0.
//   1.5.0 — the `pause` event and `features.pause`; /interrupt parks by
//           default, which was a live bug here until #68.
//   1.6.0 — no frame changed; optional `title` on session rows.
//   1.7.0 — the `wake` event.
// `features.guardrails` was backfilled in the same pass; producers have
// advertised it since core-agent#670 without a bump, which the §2.1
// additive rule permits.
//
// 2026-09-17 sync (docs/v0.5-plan.md): 1.7.0 → 1.12.0, five bumps, of
// which two are behaviour changes rather than additions.
//   1.8.0  — turn-error gains the `canceled` kind. Costs us nothing:
//            nothing under web/ reads `retryable`.
//   1.9.0  — configured-subagent rows carry optional `tools`. ABSENT
//            MEANS UNKNOWN, not "granted nothing": it is omitted both
//            by a pre-1.9.0 daemon and for a subagent with no grant.
//   1.10.0 — GET/PATCH /sessions/{sid}/acl (#797), POST
//            /sessions/{sid}/title (#808), `wake: false` on inject
//            (#698), `prompt_id` on the inject/wake responses (#840),
//            and `by`/`approver` on permission frames (#830).
//   1.11.0 — AN INJECT NO LONGER RELEASES A HOLD (#878). Through
//            1.10.0 it implicitly resumed, which is what kept a parked
//            session recoverable from a client with no resume(). It
//            does not any more, so this file has one — see resume().
//   1.12.0 — `state: "running"` is finally reachable on GET /status
//            and `turn_in_flight` arrives beside it (#896); subagent
//            stop reports what it did rather than what was asked
//            (#897). See stopSubagent() for what changed in `stopped`.
//
// Two of these routes have no feature flag upstream and are gated on
// the negotiated version alone — see protocolAtLeast in protocol.js
// for why probing is not a substitute for reading it.
//
// Depends on sibling modules (loaded ahead of this file by each shell):
//   attach-core/errors.js    — PermanentStreamError, BackendDrainingError
//   attach-core/protocol.js  — fanoutAgentFrame (legacy agent demux)
//   attach-core/replay.js    — ReplayFilter (attach cutoff)
//
// Endpoints consumed (all under <endpoint>):
//   GET  /sessions                              → list sessions
//   GET  /sessions/{sid}/events                 → SSE stream
//   POST /sessions/{sid}/inject                 → queue operator prompt
//   POST /sessions/{sid}/wake                   → resume agent after inject
//   POST /sessions/{sid}/interrupt               → cancel in-flight turn
//   POST /sessions/{sid}/pause                  → park the loop (1.5.0)
//   POST /sessions/{sid}/resume                 → release a hold (1.5.0)
//   GET  /sessions/{sid}/acl                    → who else may reach it (1.10.0)
//   PATCH /sessions/{sid}/acl                   → amend viewers/contributors
//   POST /sessions/{sid}/title                  → rename a session (1.10.0)
//   POST /sessions/{sid}/agents/{n}/stop        → halt one subagent
//   GET  /sessions/{sid}/status                 → current state snapshot
//   GET  /sessions/{sid}/tools                  → registered tools
//   GET  /sessions/{sid}/agents                 → registered (live) agents
//   GET  /sessions/{sid}/subagents              → configured subagent catalog
//   GET  /sessions/{app}/{sid}/agents/{n}/events → subagent turn drill-down
//   GET  /sessions/{sid}/guardrails             → watchdog / cost-ceiling state
//   POST /sessions/{sid}/guardrails/reset       → operator reset
//
// One endpoint is NOT under <endpoint>: GET /config, on the origin
// root, served by mast-web-server rather than by the agent. It is what
// tells the SPA where <endpoint> is in the first place, so it is a
// static on the class — see discoverConfig.
//
// SSE event types (per spec v1.12.0 §2):
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
//   pause           — 1.5.0 §2.8; the agent entered or left a hold.
//                     state + reason + resume mode + whether a turn was
//                     interrupted to get there. Anyone can cause one, so
//                     it arrives unsolicited, not only in reply to us.
//   wake            — 1.7.0 §2.9; payload is `at` and nothing else. The
//                     agent came back from a sleep. It does NOT mean an
//                     alert is waiting — §2.9 is explicit about that, and
//                     treating it as one is the obvious wrong read.
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

  // Dependencies loaded from sibling modules; solo.html and
  // spatial.html load errors.js + protocol.js + replay.js first.
  const PermanentStreamError =
    (window.AttachCoreErrors && window.AttachCoreErrors.PermanentStreamError) || null;
  const BackendDrainingError =
    (window.AttachCoreErrors && window.AttachCoreErrors.BackendDrainingError) || null;
  const fanoutAgentFrame =
    (window.AttachCoreProtocol && window.AttachCoreProtocol.fanoutAgentFrame) || null;
  const emitsEvent = (window.AttachCoreProtocol && window.AttachCoreProtocol.emitsEvent) || null;
  const hasFeature = (window.AttachCoreProtocol && window.AttachCoreProtocol.hasFeature) || null;
  const protocolAtLeast =
    (window.AttachCoreProtocol && window.AttachCoreProtocol.protocolAtLeast) || null;
  const ReplayFilter = (window.AttachCoreReplay && window.AttachCoreReplay.ReplayFilter) || null;
  if (
    !PermanentStreamError ||
    !BackendDrainingError ||
    !fanoutAgentFrame ||
    !emitsEvent ||
    !hasFeature ||
    !protocolAtLeast ||
    !ReplayFilter
  ) {
    throw new Error(
      'attach-core/client.js: missing dependencies — errors.js, protocol.js, and replay.js must load first'
    );
  }

  // ─── Deployment discovery (GET /config) ─────────────────────────────
  //
  // mast-web-server registers /config at the origin root in every mode.
  // A SPA served by anything else — the static tarball shape — gets a
  // 404 here, which is a fine answer: it means "nobody is describing
  // this deployment", and every caller already has a fallback for that.
  const CONFIG_PATH = '/config';
  // A /config that never answers must not hold the whole boot. The
  // fallback costs nothing, so give up early rather than late.
  const CONFIG_TIMEOUT_MS = 4000;

  // The descriptor for "the deployment did not describe itself". Every
  // field is present and inert, so callers can read cfg.endpoint or
  // cfg.identity without first checking cfg.ok.
  function noConfig(status) {
    return {
      ok: false,
      status: status || 0,
      // A 401 is the one failure that means something specific: the
      // deployment does authenticate, and this browser's session has
      // expired. Reloading the document is the recovery — the SPA
      // could not have loaded at all without clearing auth once.
      unauthenticated: status === 401,
      mode: '',
      endpoint: '',
      multiDaemon: false,
      backends: [],
      authMode: '',
      authenticated: false,
      identity: '',
      loginUrl: '',
      logoutUrl: '',
    };
  }

  function readConfig(body, status) {
    const auth = body.auth && typeof body.auth === 'object' ? body.auth : {};
    const str = (v) => (typeof v === 'string' ? v : '');
    const mode = str(body.mode);
    const prefix = str(body.api_prefix);
    return {
      ok: true,
      status: status,
      unauthenticated: false,
      mode: mode,
      // Only proxy mode knows where the API is, and only proxy mode is
      // asked. mock serves it at the origin root, which is already the
      // registry's first guess; static reports no prefix on purpose,
      // because there the operator picks the backend — overriding that
      // from here would be this file inventing a policy the server
      // deliberately declined to state.
      endpoint: mode === 'proxy' && prefix ? prefix : '',
      multiDaemon: !!body.multi_daemon,
      backends: Array.isArray(body.backends) ? body.backends : [],
      authMode: str(auth.mode),
      authenticated: !!auth.authenticated,
      identity: str(auth.identity),
      loginUrl: str(auth.login_url),
      logoutUrl: str(auth.logout_url),
    };
  }

  // Builds a BackendDrainingError from a 503 response, extracting the
  // Retry-After header (seconds) when present. Shared by every write
  // call that can hit routeSessionDrainGated server-side.
  function drainError(r, text) {
    const retryAfter = parseInt(r.headers.get('Retry-After') || '', 10);
    return new BackendDrainingError(
      text || 'backend is shutting down',
      Number.isFinite(retryAfter) ? retryAfter : null
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

    // ─── Deployment discovery ────────────────────────────────────────

    // GET /config — how the SPA learns what kind of deployment is
    // serving it, before it has a backend to ask. Static because there
    // is nothing to construct yet: the whole point is to find out what
    // endpoint an AttachClient should be pointed at.
    //
    // Never rejects. Every way this can fail — no such endpoint, a
    // login page where JSON was expected, a stalled fetch, an expired
    // session — resolves to a descriptor with ok:false, because the
    // caller's answer in all of those cases is the same one: keep
    // today's behavior and let the operator say where the backend is.
    // A bootstrap step that can throw would turn "this deployment
    // doesn't describe itself" into "this SPA doesn't start".
    static async discoverConfig(opts) {
      const o = opts || {};
      const url = o.url || CONFIG_PATH;
      const ms = typeof o.timeoutMs === 'number' ? o.timeoutMs : CONFIG_TIMEOUT_MS;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), ms) : 0;
      try {
        const r = await fetch(url, {
          headers: { Accept: 'application/json' },
          // The body carries this caller's identity; a cached copy is
          // either stale or someone else's. The server says no-store
          // too — this is the half of that the browser controls.
          cache: 'no-store',
          signal: ctl ? ctl.signal : undefined,
        });
        if (!r.ok) return noConfig(r.status);
        let body = null;
        try {
          body = await r.json();
        } catch {
          // An HTML login page with a 200 is the classic
          // misconfiguration, and parsing it is where a naive
          // bootstrap dies.
          return noConfig(r.status);
        }
        if (!body || typeof body !== 'object') return noConfig(r.status);
        return readConfig(body, r.status);
      } catch {
        return noConfig(0);
      } finally {
        if (timer) clearTimeout(timer);
      }
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
      return this._send('POST', path, body);
    }

    // PATCH exists for exactly one endpoint (the v1.10.0 ACL) and the
    // verb is load-bearing there: an omitted list means "leave it
    // alone" and `[]` means "clear it", which is a distinction PUT
    // cannot make. Everything else about the exchange — the drain 503,
    // the permanent-status classification, the tolerated empty body —
    // is identical to a POST, so the two share one path rather than
    // growing a second copy that drifts.
    async _patch(path, body) {
      return this._send('PATCH', path, body);
    }

    async _send(method, path, body) {
      const r = await fetch(this.endpoint + path, {
        method,
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : null,
      });
      if (r.status === 503) {
        // Daemon is draining for shutdown — /inject, /wake, and other
        // session-scoped write routes refuse intake rather than queue
        // a message that would be lost. Transient; not classified as
        // PermanentStreamError since the reconnect loop should keep
        // running and a retry after the daemon restarts will succeed.
        throw drainError(r, await r.text());
      }
      if (!r.ok) {
        const text = await r.text();
        const msg = `${method} ${path} → HTTP ${r.status}: ${text}`;
        if (PermanentStreamError.isPermanentStatus(r.status)) {
          throw new PermanentStreamError(msg, r.status);
        }
        // The status is on the plain error too. 401/403/404 get a class
        // because the stream has to decide whether to stop reconnecting;
        // a write's status is not that decision, but a caller still has
        // to be able to read it — POST /title's 501 is a capability gap
        // worth naming, and scraping it back out of the message text
        // would be a parser over a sentence we wrote.
        const err = new Error(msg);
        err.status = r.status;
        throw err;
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
      // Real backends (core-agent, mast) emit {app, user, sessionID}
      // per attach-mode-design.md; the bundled mock historically used
      // snake_case. Accept both, canonical shape first — same pattern
      // createSession below already follows.
      //
      // v1.6.0: `title` is an optional human label. Optional per row,
      // not per server — the same response can carry titled and
      // untitled rows — so callers fall back to the id rather than
      // deciding once for the whole list. Empty string, not null, so
      // `title || id` is all a caller needs.
      return (out.sessions || []).map((s) => {
        const id = s.sessionID || s.session_id || '';
        return {
          id,
          app: s.app || s.app_name || '',
          user: s.user || s.user_id || '',
          hasEventLog: !!s.has_event_log,
          status: s.status || 'active',
          lastTouchedAt: s.last_touched_at || null,
          title: typeof s.title === 'string' ? s.title : '',
          label: id,
        };
      });
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
    //
    // Content-Type is required even though DELETE carries no body:
    // core-agent's browserWriteGuard (pkg/attach/csrf.go) rejects EVERY
    // write method without `application/json` with a 415, and its error
    // text calls out the body-less case explicitly. Omitting it here
    // (while every other write site set it) made deleteSession 415
    // against any real backend.
    async deleteSession(app, sid) {
      const path = '/sessions/' + encodeURIComponent(app) + '/' + encodeURIComponent(sid);
      const r = await fetch(this.endpoint + path, {
        method: 'DELETE',
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
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

    // Pick a session to attach to, creating one if the caller owns
    // none yet.
    //
    // An empty list used to be treated as fatal, on the reading that
    // it meant a daemon with no session store. That diagnosis is
    // wrong for a hosted deployment: the agent scopes GET /sessions
    // to the calling identity, so every user's FIRST visit lists zero
    // sessions while the daemon is perfectly healthy. Dead-ending
    // there means a new user can never get in.
    //
    // A daemon that genuinely can't make sessions answers 501 to the
    // create (no SessionFactory configured), so the old advice
    // survives as the fallback — now attached to the request that
    // actually establishes it.
    async autoSelectSession() {
      let sessions = await this.listSessions();
      if (sessions.length === 0) {
        let created;
        try {
          created = await this.createSession();
        } catch (e) {
          throw new Error(
            `no sessions available and none could be created: ${e.message} ` +
              '(a daemon with no session store answers 501 — start it with --session-db)'
          );
        }
        // Re-list so the returned object has the same shape every
        // other consumer sees; fall back to the create response if
        // the backend hasn't caught up.
        sessions = await this.listSessions();
        if (sessions.length === 0) {
          sessions = [
            {
              id: created.id,
              app: created.app,
              user: created.user,
              hasEventLog: false,
              status: 'active',
              lastTouchedAt: null,
              label: created.id,
            },
          ];
        }
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
      // NOTE: EventSource cannot set custom headers, so this stream
      // carries NO bearer token. An earlier version tunnelled it as
      // ?access_token=… and claimed auth.go accepted that — it does
      // not. checkAttachToken (core-agent pkg/attach/auth.go) reads
      // only X-Attach-Token and Authorization, never the query string,
      // and `access_token` appears nowhere in core-agent or mast. The
      // param authenticated nothing and only leaked the token into
      // proxy access logs and Referer headers, so it's gone.
      //
      // Consequence: against a token-protected backend reached
      // cross-origin, this stream 401s. The supported answer is to run
      // same-origin behind mast-web-server's proxy, where the browser
      // sends cookies (or an upstream identity proxy asserts the
      // caller) and no token needs to reach the browser at all.
      //
      // Still forwards any ?fixture=<name> present on the SPA's own
      // URL. The smoke-test mock backend switches fixtures on this
      // query — letting an operator reload with
      // https://.../?fixture=002-cost-ceiling-mid-turn hits the mock's
      // scenario switch without restarting `make smoke`. Real backends
      // ignore unknown query params, so this is safe as a pass-through.
      const params = new URLSearchParams();
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

      // Typed events (spec §2). Registering a listener for an event the
      // server never sends costs nothing, so this is the union across
      // versions rather than something gated on `event_types`.
      const typed = [
        'capabilities',
        'status-update',
        'usage-update',
        'inbox',
        'turn-complete',
        'turn-error',
        // v1.5.0 §2.8 — the session's pause gate opened or closed.
        'pause',
        // v1.7.0 §2.9 — the agent's wake signal was raised.
        'wake',
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
        this._fanoutAgentFrame(frame, streamGen, isReplay, ts);
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

    _fanoutAgentFrame(frame, gen, replay, ts) {
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
      //            replay-flood). Consumers keep replay events out of
      //            the live transcript — they draw them as history
      //            instead — but still update aggregate state (usage
      //            totals, etc.) from them.
      //   ts     — the frame's server timestamp, when it carried one.
      //            Only a replayed row has any use for it: it is drawn
      //            long after the fact and must not stamp itself with
      //            the clock as it reads now. Omitted rather than
      //            spelled as null when the frame is unstamped, so a
      //            live event's shape is unchanged.
      const g = typeof gen === 'number' ? gen : this.sessionGen;
      const r = replay === true;
      const stamped = ts ? { ts } : null;
      fanoutAgentFrame(frame, (e) => this.onEvent({ ...e, gen: g, replay: r, ...stamped }));
    }

    // ─── Operator input ─────────────────────────────────────────────

    // POST /sessions/{sid}/inject — queue an operator message.
    //
    // Response (v1.10.0): { injected, session, woke, prompt_id? }.
    //
    //   woke      — which delivery this actually got. Present on both
    //               paths, so a client can confirm rather than infer.
    //               ABSENT means a pre-1.10.0 daemon, which always woke.
    //   prompt_id — the inbox id this message was filed under: the same
    //               id that comes back on the `inbox` frame and
    //               eventually names a turn on `turn-complete` (#840).
    //               Omitted when the registrant can't name one, so a
    //               caller has to handle its absence whatever it does
    //               with it. Nothing consumes it yet — the only surface
    //               with a correlation problem is the batch runner and
    //               it doesn't have one (v0.5 plan OQ 3).
    //
    // `wake: false` (#698) queues without waking and needs a registrant
    // that implements DeferredInjector — a daemon that can't defer
    // answers 501 rather than waking anyway, because the caller asked
    // for the one behaviour it can't get. Omitted entirely by default:
    // the distinction upstream draws is "said nothing" vs. "said
    // false", and a pre-1.10.0 daemon rejects an unknown key.
    //
    // What an inject no longer does, since v1.11.0 (#878): release a
    // hold. Through 1.10.0 typing into a parked session implicitly
    // resumed it; that shim is gone, so a message sent to a held
    // session queues behind a gate that only resume() opens.
    async inject(message, opts) {
      const body = { message };
      if (opts && opts.wake === false) body.wake = false;
      return this._post('/sessions/' + encodeURIComponent(this.sessionId) + '/inject', body);
    }

    // POST /sessions/{sid}/wake — run the loop now.
    //
    // Response: { woken, prompt, prompt_id? }. A wake carrying a prompt
    // IS an inject and reports `prompt_id` on the same terms; a bare
    // wake queues nothing and reports nothing.
    //
    // Like inject, this does not open a closed gate.
    async wake(prompt) {
      const body = prompt ? { prompt } : {};
      return this._post('/sessions/' + encodeURIComponent(this.sessionId) + '/wake', body);
    }

    // POST /sessions/{sid}/interrupt — cancels the current in-flight
    // turn (if any). Returns a structured shape rather than raw JSON
    // so UI code can distinguish:
    //   { ok: true, interrupted: 'yes' }              — active turn cancelled
    //   { ok: true, interrupted: 'nothing-in-flight'} — session was idle
    //   { ok: false, unsupported: true }              — 412 (agent has no
    //                                                   InterruptProvider
    //                                                   capability). UI should
    //                                                   disable the Stop button.
    // `paused` is added when the server sent a v1.5.0 body (see below).
    // Other errors propagate as thrown Error / PermanentStreamError.
    //
    // We send {"hold": false} deliberately. Protocol v1.5.0 flipped the
    // default for this endpoint from "cancel the turn" to "park the
    // loop" — core-agent resolves it as
    //
    //     hold := req.Hold == nil || *req.Hold       (handlers.go:768)
    //
    // so an empty body means HOLD. A client that omits the flag gets a
    // gate it never asked for: the operator presses Stop, sees a cancel,
    // and the session then refuses to start another turn with nothing on
    // screen saying a resume is owed. The spec's §4 requires producers to
    // keep honouring an explicit `hold: false` precisely so pre-1.5.0
    // clients can keep the old semantics — we are the client that has to
    // ask.
    //
    // `interrupt({ hold: true })` is the deliberate version — cancel the
    // turn AND park the loop, atomically — which is what an operator
    // means by "stop and let me look". It stays opt-in and off by
    // default: Stop is the gesture on screen today and it must keep
    // meaning what it has always meant. The gate closes only where
    // something also offers the way out of it (#70).
    async interrupt(opts) {
      const hold = !!(opts && opts.hold);
      const path = '/sessions/' + encodeURIComponent(this.sessionId) + '/interrupt';
      const r = await fetch(this.endpoint + path, {
        method: 'POST',
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ hold }),
      });
      if (r.status === 412) {
        // Agent doesn't implement InterruptProvider. Not an error
        // condition — just tells the caller to hide the affordance.
        return { ok: false, unsupported: true };
      }
      if (r.status === 503) {
        throw drainError(r, await r.text());
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
      const out = {
        ok: true,
        interrupted: flag === 'nothing-in-flight' ? 'nothing-in-flight' : 'yes',
      };
      // v1.5.0 added a response body — InterruptResponse in core-agent's
      // pkg/attach/pause.go — carrying {session, interrupted, paused,
      // running_subagents, stopped_subagents}. Two reasons to read it:
      //
      //   - `paused` is the post-condition gate state, so it tells us
      //     whether the `hold` we sent was actually honoured rather than
      //     leaving us to trust it. It disagreeing with what we asked
      //     for is a producer bug either way round, and callers can say
      //     so instead of leaving the operator with a session that is
      //     silently wedged (true for a false) or silently running on
      //     (false for a true).
      //   - `interrupted` is the same fact the header carries but with
      //     better semantics: it stays true while a cancelled turn is
      //     still unwinding, so an operator pressing Stop twice because
      //     nothing visibly happened is told the interrupt landed rather
      //     than "nothing in flight". Prefer it where present.
      //
      // Pre-1.5.0 producers send no body, so parse defensively and keep
      // the header reading as the fallback. `running_subagents` is not
      // surfaced yet — it wants somewhere to render (#70).
      let body = null;
      try {
        body = JSON.parse(await r.text());
      } catch {
        // No body, or not JSON — pre-v1.5.0 producer. Header stands.
      }
      if (body && typeof body === 'object') {
        if (typeof body.interrupted === 'boolean') {
          out.interrupted = body.interrupted ? 'yes' : 'nothing-in-flight';
        }
        if (typeof body.paused === 'boolean') out.paused = body.paused;
      }
      return out;
    }

    // ─── The hold (spec v1.5.0 §4) ──────────────────────────────────
    //
    // Two routes, and until v1.11.0 a client could get away with
    // neither. An inject used to release a hold as a side effect, so a
    // session parked by anyone — another tab, an embedded core-tui, a
    // scheduler, a cost ceiling — came back the moment an operator
    // typed. #878 removed that shim on the grounds that "callers carry
    // an identity, not a species", which is right and which makes
    // resume() the only way out of a gate this client did not close.
    //
    // Gate the CONTROLS on supportsPause(), not on emitsPauseEvents():
    // a server lists the `pause` event whether or not the agent behind
    // it implements PauseController, and calling either route without
    // one is a 501.

    // POST /sessions/{sid}/pause — close the gate without touching the
    // turn in flight. `reason` is shown verbatim to whoever finds the
    // session later, so it is worth writing for them rather than for a
    // log. Idempotent: `transitioned` is false when it was already
    // held, which is a 200 and not a failure.
    //
    // Returns { session, paused, transitioned, state, paused_since?,
    // pause_reason? }. Note the prefixed names: PauseResponse
    // (core-agent pkg/attach/pause.go:104-107) does not use the same
    // keys the `pause` FRAME does for the same two facts, so a consumer
    // that reads `since` off this body silently gets undefined.
    async pause(reason) {
      const body = reason ? { reason } : {};
      return this._post('/sessions/' + encodeURIComponent(this.sessionId) + '/pause', body);
    }

    // POST /sessions/{sid}/resume — open the gate, with a disposition.
    //
    //   'continue' — carry on from where it stopped. The default, and
    //                what an empty body means.
    //   'steer'    — carry on, but with this correction injected first,
    //                framed as an interrupt-steer so the model knows
    //                its last turn was killed. `steer` text is
    //                REQUIRED and non-empty; an empty one is a 400,
    //                not a silent downgrade to continue.
    //   'abandon'  — open the gate and drop the held work.
    //
    // Idempotent by design: `resumed: false` with a 200 means it wasn't
    // paused, so two operator surfaces racing the same click don't
    // produce a spurious failure.
    //
    // Returns { session, resumed, mode, state }. `mode` is the mode
    // actually applied after defaulting, which is the one to report —
    // an empty request comes back naming 'continue'.
    async resume(mode, steer) {
      const body = {};
      if (mode) body.mode = mode;
      if (steer) body.steer = steer;
      return this._post('/sessions/' + encodeURIComponent(this.sessionId) + '/resume', body);
    }

    // POST /sessions/{sid}/agents/{name}/stop — halt one background
    // subagent. Interrupting the parent only cancels the parent's turn;
    // a runaway loop inside a subagent survives every /interrupt an
    // operator can send, which is why this route exists.
    //
    // Returns { session, agent, stopped, status? }.
    //
    // READ THE 200 AS "it is no longer running", and `stopped` only as
    // "this call is what did it" (v1.12.0 #897). Through 1.11.0 the
    // route could not tell "I stopped it" from "it had already
    // finished" and answered true to both, so an operator stopping a
    // subagent that completed thirty seconds earlier was told they had
    // stopped it. `status` is what it terminated as, and is omitted by
    // a pre-1.12.0 daemon rather than being empty for a live one.
    //
    // 404 means the manager has never registered that name — the
    // operator aimed at something that does not exist. It is NOT the
    // answer for a subagent that finished on its own.
    async stopSubagent(name) {
      return this._post(
        '/sessions/' +
          encodeURIComponent(this.sessionId) +
          '/agents/' +
          encodeURIComponent(name) +
          '/stop',
        {}
      );
    }

    // ─── Sharing and naming (spec v1.10.0) ──────────────────────────

    // GET /sessions/{sid}/acl — who else may reach this session.
    // Returns { owner, viewers, contributors }; the two lists are never
    // omitted, so `[]` genuinely means nobody rather than "unreported".
    //
    // Gated on ActionSessionAdmin — owner or admin — and the READ is
    // gated as hard as the write on purpose: the ACL names the other
    // people who can see an incident, and letting a contributor
    // enumerate their co-responders is a disclosure the matrix doesn't
    // otherwise grant. So a share dialog can only ever be populated
    // for a session you own.
    //
    // A caller who may not administer it gets 404, not 403 — upstream
    // makes an unauthorized session indistinguishable from a missing
    // one on purpose. Which means you cannot feature-detect this route
    // by trying it: ask supportsACL() first.
    async getACL() {
      return this._get('/sessions/' + encodeURIComponent(this.sessionId) + '/acl');
    }

    // PATCH /sessions/{sid}/acl — amend the lists.
    //
    // A PATCH and not a PUT because omitted and empty have to stay
    // different: a field you don't send is left alone, and `[]` clears
    // it. Sending only `{contributors: [...]}` through a PUT-shaped
    // endpoint would wipe the viewers somebody set last week.
    //
    // `viewers` and `contributors` are different words for different
    // grants and must not be collapsed in the UI that calls this:
    // a viewer can watch, a contributor can write into the session.
    // Contributors is the escalation case the endpoint was filed for —
    // a watcher agent opens a session, pages a human, and the human's
    // reply arrives under their own identity and has to be allowed to
    // land.
    //
    // Owner is deliberately not a parameter. The endpoint accepts the
    // key only so it can refuse it with a reason; transfer is not a
    // thing this API does, and quietly dropping the field would let a
    // caller go on believing it is.
    //
    // Returns the stored result, so render the echo rather than what
    // you sent.
    async patchACL(patch) {
      const body = {};
      if (patch && Array.isArray(patch.viewers)) body.viewers = patch.viewers;
      if (patch && Array.isArray(patch.contributors)) body.contributors = patch.contributors;
      return this._patch('/sessions/' + encodeURIComponent(this.sessionId) + '/acl', body);
    }

    // POST /sessions/{sid}/title — rename a session.
    //
    // The `title` key is REQUIRED, and "clear it" and "leave it alone"
    // are different requests: `""` clears the name and re-arms
    // inference, an omitted key is a 400. So this method takes the
    // string and always sends it, including the empty one — which is
    // why it does not have an `if (title)` guard like wake() does.
    //
    // Returns { session, title, persisted, detail? }.
    //
    //   title     — what was STORED, after normalization (a 60-rune cap
    //               and a decorative-quote strip). Render this, not the
    //               string you sent; they differ often enough.
    //   persisted — whether the name survives a restart. FALSE IS NOT
    //               AN ERROR and is in fact the norm: a session with no
    //               ACL row has nowhere durable to write, and the
    //               rename did take effect for as long as the process
    //               lives. `detail` distinguishes the other case — a
    //               store that was wired and failed — and is the only
    //               one worth telling an operator about.
    //
    // 501 when the registrant has no title capability, which unlike the
    // ACL's 404 IS safe to feature-detect on. Gated on
    // ActionSessionWrite rather than Admin: a title is a display
    // string, not an authorization decision.
    async setTitle(title) {
      return this.setTitleFor(this.sessionId, title);
    }

    // The same call for a session this client is not attached to, which
    // is what a sidebar needs: the roster lists sessions nobody has
    // opened, and renaming one is the point of having the roster. Unlike
    // DELETE there is no {app} segment to qualify it with — the route is
    // /sessions/{sid}/title upstream, so the id has to be unambiguous on
    // its own, which within one caller's filtered listing it is.
    async setTitleFor(sid, title) {
      return this._post('/sessions/' + encodeURIComponent(sid) + '/title', {
        title: typeof title === 'string' ? title : '',
      });
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

    // GET /sessions/{sid}/perms — the permission posture plus the
    // per-session approval log. Shape (pkg/attach/state.go PermsInfo):
    //   { mode, allow?: [...], deny?: [...],
    //     approvals?: [{ tool, key?, decision, at, by? }] }
    //
    // `by` (v1.10.0, core-agent#830) is the identity the daemon
    // VERIFIED for whoever answered the prompt, and it is OMITTED —
    // not "unknown", not a placeholder — when it verified nobody, as
    // on an unauthenticated loopback listener. So a row without it is
    // an approval whose author this backend genuinely cannot name, and
    // the one identity a client must never substitute is the person
    // reading the log: they are the likeliest candidate and the most
    // damaging to guess wrong, since the log is what gets consulted
    // after something went through that should not have.
    //
    // Always 200 on a daemon with a PermsProvider; the approval log is
    // absent on older ones, which is indistinguishable here from a
    // session where nothing has been approved yet. That one is fine to
    // conflate: both mean "this log has nothing to tell you".
    async getPerms() {
      return this._get('/sessions/' + encodeURIComponent(this.sessionId) + '/perms');
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

    // GET /peers — enumerate other backend daemons this one has been
    // told about (v1.1.0+; register/heartbeat handlers in core-agent
    // pkg/attach/peers_handlers.go). Returned shape:
    //   { peers: [{ name, endpoint, labels?, registered_at,
    //               last_heartbeat, lease_expires_at }] }
    // 404 on old servers; caller should treat as an empty list.
    // Used by the multi-daemon peer fan-out path (v0.3.0 PR 2, mast-
    // web#22) to surface discoverable peers for one-click add.
    async listPeers() {
      const out = await this._get('/peers');
      return (out && out.peers) || [];
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

    // ─── Capability gating ──────────────────────────────────────────
    //
    // Thin reads over the cached capabilities frame. They exist as
    // named methods rather than inline `client.capabilities.features &&
    // ...` at each call site because the questions below look
    // interchangeable and are not, and a name is the cheapest place to
    // put that distinction where someone will see it.
    //
    // Three questions, not two, since v1.10.0: does the stream carry
    // it (emitsEvent), did the backend flag it (hasFeature), and is the
    // route even there (protocolAtLeast). The last one is not a nicety
    // — the ACL and title endpoints have no feature flag upstream to
    // read, so the version is all there is.

    // Will pause state arrive on the stream? Gate RENDERING on this.
    emitsPauseEvents() {
      return emitsEvent(this.capabilities, 'pause');
    }

    // Can this agent actually hold? Gate the pause/resume CONTROLS on
    // this — a v1.5.0 server lists the `pause` event whether or not the
    // agent behind it implements PauseController, so the event being
    // declared is not permission to draw a button. (The controls
    // themselves are #70.)
    supportsPause() {
      return hasFeature(this.capabilities, 'pause');
    }

    // Is the negotiated protocol at least `want`? The raw version
    // question, exposed because callers outside this file need it for
    // routes nobody flagged.
    protocolAtLeast(want) {
      return protocolAtLeast(this.capabilities, want);
    }

    // Can this session's ACL be read and amended? Version only —
    // core-agent ships no `acl` feature flag, and the route's 404 for
    // an unauthorized caller means trying it tells you nothing (an old
    // server and somebody else's session answer identically).
    //
    // A true here is not a promise that the call will succeed: it says
    // the route exists, not that you administer this session. The
    // share gesture belongs on sessions you own, which the browser
    // already derives — see state/daemons.js ownership().
    supportsACL() {
      return protocolAtLeast(this.capabilities, '1.10.0');
    }

    // Can this session be renamed? Version for the route, and then the
    // call's own 501 for whether the registrant implements it — unlike
    // the ACL, title's refusal is honest about being a capability gap,
    // so a caller may reasonably try and handle the 501.
    supportsTitle() {
      return protocolAtLeast(this.capabilities, '1.10.0');
    }

    // Can the operator read and reset a tripped watchdog without
    // restarting the agent? Distinct from `cost_ceiling`, which is
    // about one specific guardrail tripping. Callers of getGuardrails /
    // resetGuardrails should gate on this rather than calling blind.
    supportsGuardrails() {
      return hasFeature(this.capabilities, 'guardrails');
    }

    // GET /sessions/{sid}/guardrails — current watchdog + cost-ceiling
    // trip state. Always 200 (zero-value shape when the agent has no
    // GuardrailProvider):
    //   { watchdog: { mode, tripped, reason? },
    //     cost_ceiling: { max_turn_usd, max_session_usd,
    //                     session_cost_usd, tripped, reason?,
    //                     would_retrip },
    //     halted }
    // mode ∈ 'off' | 'warn' | 'feedback' | 'enforce'.
    // See core-agent pkg/attach/guardrails.go.
    async getGuardrails() {
      return this._get('/sessions/' + encodeURIComponent(this.sessionId) + '/guardrails');
    }

    // POST /sessions/{sid}/guardrails/reset — operator-facing reset
    // for a tripped watchdog and/or cost ceiling (unblocks the
    // /reset-ceiling UX deferred pending core-agent#331 design).
    // `guardrail` selects which one ('watchdog' | 'cost_ceiling' |
    // 'all', default 'all'); `additionalBudgetUsd` raises the cost
    // ceiling before re-checking so the reset doesn't immediately
    // re-trip on a session whose usage already exceeds it.
    //
    // A 409 means the reset would immediately re-trip (more budget
    // needed) — a structured refusal, not a transport failure, so it
    // resolves with `ok: false` rather than throwing; callers branch
    // on `ok`. See core-agent pkg/attach/handlers_operator.go:256-331.
    async resetGuardrails({ guardrail, additionalBudgetUsd } = {}) {
      const body = {};
      if (guardrail) body.guardrail = guardrail;
      if (typeof additionalBudgetUsd === 'number') body.additional_budget_usd = additionalBudgetUsd;
      const path = '/sessions/' + encodeURIComponent(this.sessionId) + '/guardrails/reset';
      const r = await fetch(this.endpoint + path, {
        method: 'POST',
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 503) {
        throw drainError(r, await r.text());
      }
      if (r.status === 409) {
        const data = await r.json();
        return { ...data, ok: false };
      }
      if (!r.ok) {
        const text = await r.text();
        const msg = `POST ${path} → HTTP ${r.status}: ${text}`;
        if (PermanentStreamError.isPermanentStatus(r.status)) {
          throw new PermanentStreamError(msg, r.status);
        }
        throw new Error(msg);
      }
      const data = await r.json();
      return { ...data, ok: true };
    }

    // GET /sessions/{sid}/subagents — the CONFIGURED subagent catalog
    // ("what's spawnable"), distinct from listAgents() above (the
    // LIVE roster of subagent instances that have actually run).
    // Always 200; empty array when the agent has no
    // SubagentCatalogProvider. Each entry:
    //   { name, description?, model?, root?, modes, tools? }
    // modes elements are 'sync' | 'async' (async-only for sessions
    // created via POST /sessions, since core-agent#741).
    //
    // `tools` (v1.9.0, core-agent#768) is the specialist's own grant,
    // and ABSENT MEANS UNKNOWN RATHER THAN NONE. It is omitted by a
    // pre-1.9.0 daemon and equally by one describing a subagent
    // configured with no tools of its own, so a renderer that prints
    // "no tools" for a missing key is guessing — and guessing wrong
    // against every older backend. The three the runtime wires into
    // every subagent regardless (return_result, report_alert,
    // schedule_next_turn) are never listed: they are a property of the
    // runtime, not of this configuration.
    // See core-agent pkg/attach/handlers.go:759-770, state.go:120-135.
    async listConfiguredSubagents() {
      const out = await this._get('/sessions/' + encodeURIComponent(this.sessionId) + '/subagents');
      return out.subagents || [];
    }

    // GET /sessions/{app}/{sid}/agents/{name}/events — a subagent's
    // persisted inner turns (ADK events, same shape as the SSE
    // `agent` frame). Paged via since/limit (defaults 0 / 500 server-
    // side, max 5000); response carries next_since + truncated for
    // resuming. 404 means the name isn't a known live or historical
    // subagent (body includes an `available` roster). 412 means the
    // backend has no event log (started without --session-db).
    // See core-agent pkg/attach/handlers_subagent_events.go.
    async getSubagentEvents(app, name, { since, limit } = {}) {
      const params = new URLSearchParams();
      if (since) params.set('since', String(since));
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const path =
        '/sessions/' +
        encodeURIComponent(app) +
        '/' +
        encodeURIComponent(this.sessionId) +
        '/agents/' +
        encodeURIComponent(name) +
        '/events' +
        (qs ? '?' + qs : '');
      return this._get(path);
    }
  }

  // Re-export the error classes as statics on the constructor so
  // callers can do `err instanceof AttachClient.PermanentStreamError`
  // without pulling in window.AttachCoreErrors directly.
  AttachClient.PermanentStreamError = PermanentStreamError;
  AttachClient.BackendDrainingError = BackendDrainingError;

  return AttachClient;
})();
