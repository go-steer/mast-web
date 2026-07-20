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
//     — Normalize a capabilities frame into a stable shape. v0.2.0
//       consumers read protocol_version / event_types / server; v1.3.0
//       will add features / slash_commands / agent / caller_id (see
//       core-agent#329). Returns null on non-object input.

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

  return { fanoutAgentFrame, parseCapabilities };
})();
