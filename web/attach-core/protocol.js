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

  return { fanoutAgentFrame, parseCapabilities, emitsEvent, hasFeature };
})();
