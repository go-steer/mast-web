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

// attach-core/replay — cutoff filter for historical replay events on
// SSE attach. When a client attaches to a long-running session, the
// server's broadcaster typically re-streams every prior frame in the
// eventlog before switching to live tail. Without a filter, the
// browser transcript scrolls through 1000 turns of history before
// showing anything new.
//
// Ports the pattern from core-agent/internal/coretuiremote/adapter.go
// (connectedAt - replayGrace cutoff). Events with a server-provided
// timestamp older than (connectedAt - graceMs) are classified as
// replay. Aggregate state (usage totals, MCP list, etc.) still
// updates from replay events; only the transcript view suppresses
// them.
//
// Loaded ahead of client.js in index.html. Exposed as
// window.AttachCoreReplay.

window.AttachCoreReplay = (function () {
  'use strict';

  // Default grace window — covers clock skew between server + client
  // and events that landed just before attach (rare but plausible: a
  // turn was finishing as we connected). Matches the 2s value in
  // core-agent/internal/coretuiremote/adapter.go's replayGrace const.
  const DEFAULT_REPLAY_GRACE_MS = 2000;

  class ReplayFilter {
    constructor({ graceMs, connectedAt } = {}) {
      this.graceMs = typeof graceMs === 'number' ? graceMs : DEFAULT_REPLAY_GRACE_MS;
      // connectedAt as a millisecond epoch. Default to the current
      // wall clock (client-side "now"); callers may pass an explicit
      // value to align to a specific connection moment.
      this.connectedAt = typeof connectedAt === 'number' ? connectedAt : Number(new Date());
      this.cutoff = this.connectedAt - this.graceMs;
    }

    // isReplay returns true when the supplied timestamp is older than
    // the cutoff and the event should be suppressed from the
    // transcript. Timestamps may be:
    //   - a millisecond epoch Number
    //   - an ISO-8601 string (server default for JSON serialization)
    //   - undefined / null (unknown — never classify as replay,
    //     fail-open so we don't drop live events on servers that
    //     don't stamp their frames)
    isReplay(timestamp) {
      if (timestamp == null) return false;
      let t;
      if (typeof timestamp === 'number') {
        t = timestamp;
      } else if (typeof timestamp === 'string') {
        t = Date.parse(timestamp);
        if (Number.isNaN(t)) return false;
      } else {
        return false;
      }
      return t < this.cutoff;
    }

    // extractTimestamp pulls a wire-level timestamp out of a legacy
    // agent frame's inner event, tolerating both PascalCase and
    // snake_case field names. Returns null when no timestamp field
    // is present. Kept here (rather than in protocol.js) because the
    // extraction is specifically for replay-cutoff and only the
    // ReplayFilter's consumer needs it.
    static extractAgentFrameTimestamp(frame) {
      if (!frame || !frame.event) return null;
      const ev = frame.event;
      return ev.Timestamp || ev.timestamp || null;
    }
  }

  // ─── Replayed history ────────────────────────────────────────────
  //
  // ReplayFilter says which events are history. This says what to do
  // with them: a reattached session should get its transcript back,
  // and until now the classified events were simply dropped, so a
  // reload showed an empty panel over a live session (#51).
  //
  // Drawing all of it is not an option either — that is the scroll of
  // a thousand turns the filter exists to prevent. So the buffer holds
  // the classified events and hands them back a few turns at a time:
  // the newest few on attach, more on request. Nothing is re-fetched,
  // because nothing needs to be — the server re-streams the entire
  // eventlog on every attach and there is no pagination endpoint for
  // session history to page against. The whole log is already here;
  // the only question is how much of it is on screen.
  //
  // Turns, not events, are the unit: "show 5 earlier turns" is worth
  // saying and "show 50 earlier events" is not. A turn starts at the
  // user-authored frame the backend echoes when it hands the model a
  // prompt.

  // Events kept per attach. The cap is what stops a long-running
  // session from parking its whole transcript in memory four panels
  // over; past it the oldest are dropped and `truncated` says so, so
  // the view can admit the log goes back further rather than claim
  // history starts there.
  const DEFAULT_MAX_EVENTS = 2000;

  class ReplayHistory {
    constructor({ maxEvents } = {}) {
      this.maxEvents = typeof maxEvents === 'number' ? maxEvents : DEFAULT_MAX_EVENTS;
      // Whether events were dropped off the old end to stay under the
      // cap. Never unset: the log really did go back further.
      this.truncated = false;
      this._groups = [];
      this._events = 0;
      // The group still accepting events, or null once a window has
      // been handed out — a straggler that arrives after its turn is
      // on screen starts a new group rather than reopening a drawn one.
      this._open = null;
      // Index of the oldest group handed out, and one past the newest.
      this._from = 0;
      this._to = 0;
    }

    // True when this event is a backend prompt echo, which is where a
    // turn begins on the wire.
    static startsTurn(ev) {
      return !!(ev && ev.type === 'stream-chunk' && ev.data && ev.data.author === 'user');
    }

    push(ev) {
      if (!ev) return;
      if (!this._open || ReplayHistory.startsTurn(ev)) {
        this._open = { events: [] };
        this._groups.push(this._open);
      }
      this._open.events.push(ev);
      this._events += 1;
      this._trim();
    }

    // Turns still older than everything handed out.
    get olderCount() {
      return this._from;
    }

    get turnCount() {
      return this._groups.length;
    }

    get eventCount() {
      return this._events;
    }

    // The n newest turns — the initial render window.
    newest(n) {
      const count = Math.max(0, Math.min(n, this._groups.length));
      this._to = this._groups.length;
      this._from = this._to - count;
      this._open = null;
      return this._groups.slice(this._from, this._to);
    }

    // Up to n turns immediately older than the window, oldest first,
    // so the caller can prepend the returned array as it stands.
    earlier(n) {
      if (this._from <= 0) return [];
      const start = Math.max(0, this._from - Math.max(0, n));
      const out = this._groups.slice(start, this._from);
      this._from = start;
      return out;
    }

    _trim() {
      // One group always survives: a single turn longer than the cap
      // is still the only thing there is to show.
      while (this._events > this.maxEvents && this._groups.length > 1) {
        const dropped = this._groups.shift();
        this._events -= dropped.events.length;
        this.truncated = true;
        if (this._from > 0) this._from -= 1;
        if (this._to > 0) this._to -= 1;
      }
    }
  }

  // A real backend hands the model its prompt wrapped for delivery:
  //
  //   [Inbox]\n- what the operator typed\n\n---\n\n
  //
  // Live, that echo is suppressed outright — submit() has already
  // drawn the operator's own copy. Replayed, it is the only record of
  // the prompt there is, so the wrapper comes off instead of the
  // message. Anything that isn't in that shape is returned trimmed.
  const INBOX_WRAPPER = /^\[Inbox\]\s*\n((?:-\s?.*(?:\n|$))+)\n?---\s*\n*/;

  function stripInboxWrapper(text) {
    const s = text || '';
    const m = INBOX_WRAPPER.exec(s);
    if (!m) return s.trim();
    return m[1].replace(/^-\s?/gm, '').trim();
  }

  return {
    ReplayFilter,
    ReplayHistory,
    stripInboxWrapper,
    DEFAULT_REPLAY_GRACE_MS,
    DEFAULT_MAX_EVENTS,
  };
})();
