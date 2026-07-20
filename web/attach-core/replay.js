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

  return { ReplayFilter, DEFAULT_REPLAY_GRACE_MS };
})();
