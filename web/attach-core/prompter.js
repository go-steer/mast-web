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

// attach-core/prompter — SSE consumer for /sessions/{sid}/perms/stream,
// paired with helpers for POST /perms/respond and the batch
// /perms/allow + /perms/deny endpoints.
//
// The perms stream is a SECOND EventSource, distinct from the main
// event stream. Runs for the lifetime of a connected session; a
// modal opens per `prompt` frame and the operator's Allow / Deny
// choice POSTs back to /perms/respond with the frame ID.
//
// Reconnect strategy mirrors core-agent/internal/coretuiremote/
// prompter.go:55-93 — exponential backoff (5s → 10s → 30s), 501
// classified as terminal (agent lacks PromptBrokerProvider), all
// other errors retry.
//
// Wire shapes (from core-agent/pkg/attach/types_prompts.go):
//   PromptFrame — { id, kind, tool, detail?, verb?, source?,
//                   persist_tool?, persist_key?, access?, at }
//   PromptResponse — { id, decision } where decision ∈
//     { "deny", "allow-once", "allow-session", "allow-session-verb",
//       "allow-session-tool", "allow-always" }
//
// Loaded ahead of client.js in index.html (via
// window.AttachCorePrompter).

window.AttachCorePrompter = (function () {
  'use strict';

  // Reconnect backoff schedule in ms. Repeats the last value for
  // subsequent attempts. Matches coretuiremote/prompter.go's cadence.
  const BACKOFF_SCHEDULE_MS = [5000, 10000, 30000];

  class Prompter {
    constructor({ endpoint, token, sessionId, onPrompt, onTerminal } = {}) {
      this.endpoint = (endpoint || '').replace(/\/$/, '');
      this.token = token || '';
      this.sessionId = sessionId || '';
      this.onPrompt = onPrompt || (() => {});
      // Called once when the reconnect loop gives up (501 = agent has
      // no PromptBrokerProvider capability). UI should hide the perms
      // modal-triggering surface for the session.
      this.onTerminal = onTerminal || (() => {});
      this._es = null;
      this._closed = false;
      this._attempts = 0;
    }

    // Build the /perms/stream URL. The path uses the sid shortcut form
    // (no {app}) since that's what the main client uses.
    //
    // Carries no token: EventSource can't set headers, and the
    // ?access_token= param this used to append authenticated nothing —
    // core-agent's checkAttachToken reads only X-Attach-Token and
    // Authorization. See the matching note in client.js connect().
    _streamURL() {
      return this.endpoint + '/sessions/' + encodeURIComponent(this.sessionId) + '/perms/stream';
    }

    _headers() {
      const h = { Accept: 'application/json' };
      if (this.token) {
        h['Authorization'] = 'Bearer ' + this.token;
        h['X-Attach-Token'] = this.token;
      }
      return h;
    }

    // Start listening. Idempotent — a second call is a no-op unless
    // the previous stream was closed.
    connect() {
      if (this._es || this._closed) return;
      this._attempts = 0;
      this._open();
    }

    _open() {
      try {
        this._es = new EventSource(this._streamURL());
      } catch (e) {
        this._scheduleReconnect(e);
        return;
      }
      this._es.addEventListener('prompt', (e) => {
        let frame = null;
        try {
          frame = JSON.parse(e.data);
        } catch {
          return;
        }
        // Reset attempts on any successful frame — a healthy stream
        // shouldn't start backoff-heavy after an outage recovers.
        this._attempts = 0;
        this.onPrompt(frame);
      });
      // EventSource auto-retries on transport errors; onerror fires
      // for both transient (5xx, dropped connection) and permanent
      // (501, 404, 403, 401) states. We can't inspect the HTTP status
      // from an EventSource error event directly, so we do a HEAD-ish
      // probe on subsequent reconnects: if a fresh EventSource opens
      // and immediately errors again N times in a row, treat as
      // terminal after the backoff schedule exhausts.
      this._es.addEventListener('error', () => {
        if (this._closed) return;
        // EventSource may have already scheduled its own retry; close
        // and take over so we control the backoff cadence.
        try {
          this._es.close();
        } catch {
          // ignore
        }
        this._es = null;
        this._scheduleReconnect(null);
      });
    }

    _scheduleReconnect(_err) {
      if (this._closed) return;
      this._attempts += 1;
      // After 6 consecutive failures at the max backoff, give up
      // and surface terminal. That's roughly 3 minutes of retries
      // (5 + 10 + 30 + 30*3) which is enough to survive most
      // network blips but not a permanently-broken endpoint.
      if (this._attempts > BACKOFF_SCHEDULE_MS.length + 3) {
        this._closed = true;
        this.onTerminal(new Error('perms stream reconnect gave up after repeated failures'));
        return;
      }
      const idx = Math.min(this._attempts - 1, BACKOFF_SCHEDULE_MS.length - 1);
      const delay = BACKOFF_SCHEDULE_MS[idx];
      setTimeout(() => this._open(), delay);
    }

    disconnect() {
      this._closed = true;
      if (this._es) {
        try {
          this._es.close();
        } catch {
          // ignore
        }
        this._es = null;
      }
    }

    // POST /perms/respond — { id, decision }. Decision must be a
    // wire-stable string per core-agent's DecisionFromWire mapping:
    //   "deny" | "allow-once" | "allow-session" | "allow-session-verb"
    //   | "allow-session-tool" | "allow-always"
    async respond(id, decision) {
      const path = '/sessions/' + encodeURIComponent(this.sessionId) + '/perms/respond';
      const r = await fetch(this.endpoint + path, {
        method: 'POST',
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`POST ${path} → HTTP ${r.status}: ${text}`);
      }
      return true;
    }

    // POST /perms/allow — { patterns: […] } — batch allowlist add.
    // Useful for a future "manage permissions" view; wire target the
    // shape now so we don't reshape the API later.
    async allow(patterns) {
      return this._postPatterns('/perms/allow', patterns);
    }

    async deny(patterns) {
      return this._postPatterns('/perms/deny', patterns);
    }

    async _postPatterns(subpath, patterns) {
      const path = '/sessions/' + encodeURIComponent(this.sessionId) + subpath;
      const r = await fetch(this.endpoint + path, {
        method: 'POST',
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ patterns: patterns || [] }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`POST ${path} → HTTP ${r.status}: ${text}`);
      }
      return true;
    }
  }

  return { Prompter, BACKOFF_SCHEDULE_MS };
})();
