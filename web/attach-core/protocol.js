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

// attach-core/protocol — pure event-parsing helpers for the attach SSE
// wire protocol (spec v1.2.0). No DOM, no network, no state — just
// takes a parsed SSE frame and emits typed sub-events via a callback.
//
// Extracted from client.js so the same parsing logic can run under the
// conformance harness (which feeds fixture JSONL through a synthetic
// emit function and diffs the resulting event stream) and so future
// consumers (a second core built on the same wire) can reuse it.
//
// Loaded ahead of client.js in index.html.
//
// Public API on window.AttachCoreProtocol:
//   fanoutAgentFrame(frame, emit)
//     — Decompose a legacy `agent` frame (ADK session.Event) into typed
//       sub-events (stream-chunk / tool-call / tool-result) and pass
//       each to emit({type, data}). Handles both PascalCase and
//       camelCase field variants; tolerates missing Content/parts.
//   parseCapabilities(data)
//     — Normalize a capabilities frame into a stable shape. Consumers
//       read protocol_version / event_types / server, plus (since
//       v1.4.0, core-agent#329) features / slash_commands / agent /
//       caller_id. Returns null on non-object input.
//   emitsEvent(caps, name)
//     — Will this server send this SSE event?
//   hasFeature(caps, name)
//     — Did this server advertise this feature flag? Different
//       question from emitsEvent; see the note above the two.
//   protocolAtLeast(caps, want)
//     — Is the negotiated protocol version at least `want`? The third
//       gating question, and the only one that answers for endpoints
//       nobody flagged; see the note above it.

window.AttachCoreProtocol = (function () {
  'use strict';

  function fanoutAgentFrame(frame, emit) {
    if (!frame || !frame.event) return;
    const ev = frame.event;
    const content = ev.Content || ev.content;
    if (!content || !content.parts) return;

    for (const part of content.parts) {
      // Streamed text chunk.
      if (typeof part.text === 'string' && part.text.length > 0) {
        emit({
          type: 'stream-chunk',
          data: {
            text: part.text,
            partial: !!(ev.Partial || ev.partial),
            author: ev.Author || ev.author || '',
          },
        });
        continue;
      }
      // Function call (tool invocation).
      const fc = part.functionCall || part.function_call || part.FunctionCall;
      if (fc) {
        emit({
          type: 'tool-call',
          data: {
            id: fc.id || fc.ID || '',
            name: fc.name || fc.Name || '',
            args: fc.args || fc.Args || {},
          },
        });
        continue;
      }
      // Function response (tool result).
      const fr = part.functionResponse || part.function_response || part.FunctionResponse;
      if (fr) {
        const response = fr.response || fr.Response || {};
        // v1.2.0: latency_ms rides as a sidecar key in the response
        // map (ADK constraint — tool.Run can't set CustomMetadata).
        // Browser JSON decode makes it a Number; accept absent or 0.
        const latencyMs = typeof response.latency_ms === 'number' ? response.latency_ms : 0;
        emit({
          type: 'tool-result',
          data: {
            id: fr.id || fr.ID || '',
            name: fr.name || fr.Name || '',
            response,
            latencyMs,
          },
        });
        continue;
      }
    }
  }

  function parseCapabilities(data) {
    if (!data || typeof data !== 'object') return null;
    // Forward-compat: pass through unknown fields verbatim; consumers
    // read only what they know about and tolerate the rest.
    return { ...data };
  }

  // ── Capability gating ──────────────────────────────────────────────
  //
  // A capabilities frame answers two different questions and they have
  // two different answers. Conflating them is the mistake the spec
  // calls out by name, so the two questions get two functions:
  //
  //   emitsEvent(caps, 'pause')     — will state arrive on the stream?
  //   hasFeature(caps, 'pause')     — can I offer the control?
  //
  // A v1.5.0 server lists `pause` in event_types whether or not the
  // agent behind it can actually hold. So a client that reads only
  // event_types offers a Pause button that does nothing, and one that
  // reads only features ignores a pause somebody else caused. Render
  // received state off the first; offer controls off the second.

  // emitsEvent reports whether the server said it can send this SSE
  // event. Absent event_types means a pre-v1.1.0 server that never
  // declared one — assume the classic set is present rather than
  // rendering nothing, but don't assume anything newer.
  const CLASSIC_EVENTS = [
    'capabilities',
    'status-update',
    'usage-update',
    'inbox',
    'turn-complete',
    'turn-error',
    'agent',
  ];

  function emitsEvent(caps, name) {
    if (!caps || typeof caps !== 'object') return false;
    const types = caps.event_types;
    if (!Array.isArray(types)) return CLASSIC_EVENTS.includes(name);
    return types.includes(name);
  }

  // hasFeature reports whether the server advertised a feature flag.
  //
  // An absent `features` map means a pre-v1.4.0 server, which had no
  // way to say no — assume on, matching what the shells already do. An
  // absent KEY inside a present map is the same case for a flag added
  // after that server was built: the additive rule (§2.1) lets a
  // producer stay silent about something it predates, and reading that
  // silence as "off" would switch off working features on older
  // backends every time the spec grows one.
  function hasFeature(caps, name) {
    if (!caps || typeof caps !== 'object') return true;
    const features = caps.features;
    if (!features || typeof features !== 'object') return true;
    if (!(name in features)) return true;
    return !!features[name];
  }

  // ── Version gating ─────────────────────────────────────────────────
  //
  // The third question, and the one the two above cannot answer:
  // "does this endpoint exist?"
  //
  // `features` only covers capabilities somebody thought to flag, and
  // several do not have a flag at all — the v1.10.0 ACL and title
  // routes are gated on the protocol version and nothing else
  // (core-agent has no featureACL / featureTitle; checked, not
  // assumed). For those, the negotiated version is the only thing on
  // the wire that says whether the route is there.
  //
  // Probing is not an alternative for the ACL. A caller who may not
  // administer a session gets 404, not 403, deliberately — upstream
  // makes an unauthorized session indistinguishable from a missing one
  // (handlers_acl.go's note on authorize) — so "404" means either "old
  // server" or "not yours", and a client that feature-detects by
  // trying cannot tell the two apart. Read the version instead. Title
  // is the friendlier case: it answers 501 when the capability isn't
  // registered, which IS safe to detect on, but it still needs the
  // version to know the route exists to answer at all.
  //
  // Comparison is numeric per component, not lexicographic: "1.10.0"
  // sorts BEFORE "1.7.0" as a string, which would hide every endpoint
  // this function exists to unlock.
  //
  // An absent or unparseable version means a producer too old to have
  // declared one (pre-v1.1.0) — false, i.e. offer nothing new. That is
  // the opposite default from hasFeature, and deliberately so: there,
  // silence is a producer that predates a flag for a feature it does
  // have; here, silence is a producer that predates the route.
  function parseVersion(v) {
    if (typeof v !== 'string') return null;
    const parts = v.trim().split('.');
    if (parts.length === 0 || parts.length > 3) return null;
    const out = [0, 0, 0];
    for (let i = 0; i < parts.length; i++) {
      // Tolerate a pre-release suffix ("1.12.0-rc1") on the last
      // component: the release it is a candidate for is the honest
      // answer, and refusing to parse it would switch off every route
      // against a daemon built from a tag.
      const n = parseInt(parts[i], 10);
      if (!Number.isInteger(n) || n < 0) return null;
      out[i] = n;
    }
    return out;
  }

  function protocolAtLeast(caps, want) {
    if (!caps || typeof caps !== 'object') return false;
    const got = parseVersion(caps.protocol_version);
    const min = parseVersion(want);
    if (!got || !min) return false;
    for (let i = 0; i < 3; i++) {
      if (got[i] !== min[i]) return got[i] > min[i];
    }
    return true;
  }

  return { fanoutAgentFrame, parseCapabilities, emitsEvent, hasFeature, protocolAtLeast };
})();
