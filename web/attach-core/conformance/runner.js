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

// Conformance harness runner — feeds a fixture stream of SSE frames
// through the attach-core protocol layer and returns the observed
// typed-event sequence. The vitest wrapper in conformance.test.js
// compares against the fixture's expected sequence.
//
// This is intentionally NOT a client — no HTTP, no state, no
// reconnect logic. Just the pure event projection. Same seam the
// core-agent Go runner (core-agent#330) will exercise.

/**
 * Run a fixture through the protocol layer.
 *
 * @param {Array<{event: string, data: object}>} frames — parsed SSE
 *   frames as they'd arrive on the wire (one per SSE `event:` block).
 * @param {{fanoutAgentFrame: Function}} protocol — the AttachCoreProtocol
 *   module (or a compatible shim).
 * @returns {Array<{type: string, data: object}>} — the observed typed
 *   event stream. Same shape a real client's onEvent callback receives.
 */
export function runFixture(frames, protocol) {
  const observed = [];
  const emit = (e) => observed.push(e);
  for (const frame of frames) {
    if (!frame || typeof frame.event !== 'string') continue;
    if (frame.event === 'agent') {
      // Legacy multiplexed frame — fan out to typed sub-events.
      protocol.fanoutAgentFrame(frame.data, emit);
      continue;
    }
    // Typed events (capabilities, status-update, usage-update, inbox,
    // turn-complete, turn-error) pass through unchanged.
    emit({ type: frame.event, data: frame.data });
  }
  return observed;
}

/**
 * Parse a JSONL string into an array of objects.
 * Ignores blank lines and lines that fail JSON.parse (with a comment
 * about the invalid line prepended into an error thrown at end so
 * fixture authoring mistakes surface fast).
 */
export function parseJSONL(text) {
  const out = [];
  const errs = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      out.push(JSON.parse(trimmed));
    } catch (e) {
      errs.push(`line ${i + 1}: ${e.message}`);
    }
  });
  if (errs.length > 0) {
    throw new Error('parseJSONL: ' + errs.join('; '));
  }
  return out;
}
