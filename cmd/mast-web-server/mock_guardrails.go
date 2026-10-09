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

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Guardrail trips (protocol 1.13.0, core-agent#891) and the durable rows
// that record them and every turn error (1.19.0, core-agent#1258).
//
// Until v0.6 the mock's guardrails were a constant that never tripped,
// so nothing a client did about a halt could be tested. That mattered
// more than it sounds: since 1.13.0 a trip is announced on its own
// `guardrail-trip` frame, which v0.5.0 drops, so against a current
// daemon a halt shows only as the bare `canceled` that follows it. And
// since core-agent#1040 an inject into a halted session is queued and
// runs nothing until a reset, so a client that waits for that turn to
// end waits forever. The mock has to be able to do both before the
// browser can be fixed (v0.6 plan §2, §7).
//
// What a trip looks like on the wire, in order, matching upstream's
// conformance captures (pkg/attach/testdata/conformance/guardrail-trip-*):
//
//   1. `guardrail-trip` {guardrail, reason, halted_turn, event_id}
//   2. if halted_turn: the cut turn's `canceled`, as a durable
//      `agent/turn-error` row and then its typed `turn-error` frame —
//      a turn error's row is written before its frame (attach-http.md,
//      "Trips and turn errors are durable")
//   3. the trip's own row, `agent/guardrail-trip` for a trip that halted
//      the session, `agent/guardrail-turn-trip` for one that did not —
//      a trip's frame goes out when the guardrail fires and its row
//      lands at the turn's cleanup
//
// A trip is not always a halt. Since core-agent#1049 a per-turn cost
// trip ends its turn and leaves the session running; there is
// deliberately no halted_session field on the frame. GET /guardrails
// `halted` is the authority, and it is what this file keeps.

// mockTrip is one guardrail's trip state for a session.
type mockTrip struct {
	tripped bool
	reason  string
}

// mockGuardrailState is one session's guardrails. Zero value is
// untripped, so an unknown session reads as clear without being created.
type mockGuardrailState struct {
	trips map[string]mockTrip // keyed by guardrail name
	// queued records a message injected while halted. Upstream queues
	// it and the first turn after the reset drains it (attach-http.md,
	// "Injecting into a guardrail-halted session"), so the reset here
	// starts a turn when this is set.
	queued bool
}

func (st mockGuardrailState) halted() bool {
	for _, t := range st.trips {
		if t.tripped {
			return true
		}
	}
	return false
}

func (st mockGuardrailState) trip(name string) mockTrip { return st.trips[name] }

type mockGuardrails struct {
	mu sync.Mutex
	m  map[string]mockGuardrailState
}

func (g *mockGuardrails) get(sid string) mockGuardrailState {
	g.mu.Lock()
	defer g.mu.Unlock()
	st := g.m[sid]
	// A copy of the trips map, so a caller editing its copy can't race
	// another request reading this one.
	trips := make(map[string]mockTrip, len(st.trips))
	for k, v := range st.trips {
		trips[k] = v
	}
	st.trips = trips
	return st
}

func (g *mockGuardrails) set(sid string, st mockGuardrailState) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.m == nil {
		g.m = make(map[string]mockGuardrailState)
	}
	g.m[sid] = st
}

func (g *mockGuardrails) reset() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.m = nil
}

// guardrailsWire is GET /sessions/{sid}/guardrails (core-agent#670/#671)
// from the session's state. The numbers are the old constant's; the
// tripped flags, reasons and `halted` are real.
func (h *mockHandler) guardrailsWire(sid string) map[string]any {
	st := h.guardrails.get(sid)
	wd := st.trip("watchdog")
	cc := st.trip("cost_ceiling")
	watchdog := map[string]any{"mode": "warn", "tripped": wd.tripped}
	if wd.reason != "" {
		watchdog["reason"] = wd.reason
	}
	cost := map[string]any{
		"max_turn_usd":     1.0,
		"max_session_usd":  10.0,
		"session_cost_usd": 0.02,
		"tripped":          cc.tripped,
		"would_retrip":     false,
	}
	if cc.reason != "" {
		cost["reason"] = cc.reason
	}
	return map[string]any{
		"watchdog":     watchdog,
		"cost_ceiling": cost,
		"halted":       st.halted(),
	}
}

// resetGuardrails backs POST .../guardrails/reset. `guardrail` selects
// one ('watchdog' | 'cost_ceiling'); absent or 'all' resets both. When
// that clears the halt, a message queued while halted runs, as upstream
// drains its inbox on the first turn after a reset.
func (h *mockHandler) resetGuardrails(w http.ResponseWriter, r *http.Request, sid string) {
	var req struct {
		Guardrail string `json:"guardrail"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	drainBody(r)
	st := h.guardrails.get(sid)
	wasHalted := st.halted()
	var reset []string
	for _, name := range []string{"watchdog", "cost_ceiling"} {
		if req.Guardrail == "" || req.Guardrail == "all" || req.Guardrail == name {
			if st.trips != nil {
				delete(st.trips, name)
			}
			reset = append(reset, name)
		}
	}
	drain := wasHalted && !st.halted() && st.queued
	if drain {
		st.queued = false
	}
	h.guardrails.set(sid, st)
	if drain && !h.gates.get(sid).paused {
		h.hub.publish(sid, wakeFrame(time.Now()))
		h.startTurn(sid, "")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"reset":      reset,
		"guardrails": h.guardrailsWire(sid),
	})
}

// resetGuardrailState backs DELETE /_mock/guardrails. Test-only, like
// the pause-gate reset beside it: a halt left behind by one spec would
// make every later inject silently queue.
func (h *mockHandler) resetGuardrailState(w http.ResponseWriter, _ *http.Request) {
	h.guardrails.reset()
	writeEmpty(w, http.StatusNoContent)
}

// defaultTripReason is the producer's wording for each case, from
// upstream's own captures where one exists. The reason is what an
// operator reads, and it names the reset rather than a Go symbol
// (core-agent#666), so a client renders it verbatim.
func defaultTripReason(guardrail string, halts bool) string {
	switch {
	case guardrail == "watchdog":
		return "watchdog halted the agent (repeated-tool-call): looping on read_file with identical args. " +
			"Clear it with /guardrail reset watchdog, or POST /sessions/{app}/{sid}/guardrails/reset."
	case halts:
		return "session cost ceiling exceeded: the session has cost $10.02, ceiling is $10.00. " +
			"Clear it with /guardrail reset cost_ceiling."
	default:
		return "per-turn cost ceiling exceeded: this turn cost $0.0112, ceiling is $0.0100. " +
			"The turn was stopped with its work unfinished; the session is NOT halted."
	}
}

// raiseGuardrailTrip backs POST /_mock/guardrail-trip — test-only, the
// guardrail counterpart to /_mock/perms-prompt. Body:
//
//	{ "session": "smoke-session",          required
//	  "guardrail": "cost_ceiling",         or "watchdog"; default cost_ceiling
//	  "reason": "…",                       default: the producer's wording
//	  "halted_turn": true,                 default: whether a turn is in flight
//	  "halts_session": true }              default true; false = a per-turn trip
//
// halted_turn true cuts the playing turn and sends its `canceled`. It is
// honoured even with no turn in flight, because the spec's promise is
// about the frames ("exactly one canceled follows") and a test of the
// absorb needs to be able to make that promise without a turn racing.
func (h *mockHandler) raiseGuardrailTrip(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Session      string `json:"session"`
		Guardrail    string `json:"guardrail"`
		Reason       string `json:"reason"`
		HaltedTurn   *bool  `json:"halted_turn"`
		HaltsSession *bool  `json:"halts_session"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		drainBody(r)
		writeError(w, http.StatusBadRequest, "guardrail-trip: malformed JSON body\n")
		return
	}
	drainBody(r)
	sid := req.Session
	if sid == "" {
		writeError(w, http.StatusBadRequest, "guardrail-trip: session is required\n")
		return
	}
	guardrail := req.Guardrail
	if guardrail == "" {
		guardrail = "cost_ceiling"
	}
	halts := req.HaltsSession == nil || *req.HaltsSession
	gate := h.gates.get(sid)
	haltedTurn := gate.turnInFlight
	if req.HaltedTurn != nil {
		haltedTurn = *req.HaltedTurn
	}
	reason := req.Reason
	if reason == "" {
		reason = defaultTripReason(guardrail, halts)
	}

	if haltedTurn {
		// The cut is final before anything is said about it: no frame of
		// the turn may land between the trip and its cancel.
		h.turns.stop(sid)
	}
	tripID := h.nextEventID()
	h.publishJSON(sid, "guardrail-trip", map[string]any{
		"guardrail":   guardrail,
		"reason":      reason,
		"halted_turn": haltedTurn, // always present, false included (spec §2.10)
		"event_id":    tripID,
	})

	if halts {
		st := h.guardrails.get(sid)
		if st.trips == nil {
			st.trips = map[string]mockTrip{}
		}
		st.trips[guardrail] = mockTrip{tripped: true, reason: reason}
		h.guardrails.set(sid, st)
	}

	if haltedTurn {
		gate = h.gates.get(sid)
		gate.turnInFlight = false
		h.gates.set(sid, gate)
		h.perms.cancelPending(sid)
		h.publishTurnError(sid, canceledPayload(), guardrail)
	}

	author, invocation := "agent/guardrail-turn-trip", "guardrail-turn-trip"
	if halts {
		author, invocation = "agent/guardrail-trip", "guardrail-trip"
	}
	h.publishRow(sid, author, invocation, tripID, map[string]any{
		"source":      "agent",
		"guardrail":   guardrail,
		"reason":      reason,
		"halted_turn": haltedTurn,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"raised":   true,
		"event_id": tripID,
		"halted":   h.guardrails.get(sid).halted(),
	})
}

// ─── Durable rows (1.19.0) ───────────────────────────────────────────

// nextEventID mints the id a durable row and its typed frame share.
func (h *mockHandler) nextEventID() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.events++
	return fmt.Sprintf("mock-event-%d", h.events)
}

// publishJSON publishes one typed frame built from a map.
func (h *mockHandler) publishJSON(sid, event string, payload map[string]any) {
	buf, _ := json.Marshal(payload)
	h.hub.publish(sid, frame{Event: event, Data: buf})
}

// publishRow publishes an eventlog row the way the broadcaster tails
// one onto the stream: the back-compat `agent` frame, Frame{seq, event},
// with no Content — so the model never sees it and a pre-1.19.0 client
// drops it — and the metadata a reader keys on. Shape from upstream's
// dev/uat/gke-drill/a2_count_selftest.py, which counts these off real
// replays.
func (h *mockHandler) publishRow(sid, author, invocation, id string, meta map[string]any) {
	h.mu.Lock()
	h.seq++
	seq := h.seq
	h.mu.Unlock()
	h.publishJSON(sid, "agent", map[string]any{
		"seq": seq,
		"event": map[string]any{
			"ID":             id,
			"Author":         author,
			"InvocationID":   invocation,
			"CustomMetadata": meta,
		},
	})
}

// publishTurnError ends a turn with an error the way 1.19.0 does: the
// durable `agent/turn-error` row first, then the typed frame carrying
// the row's id as event_id, so a client attached for both can count the
// failure once. cutBy names the guardrail whose cut caused it, empty
// when none did.
func (h *mockHandler) publishTurnError(sid string, payload map[string]any, cutBy string) {
	id := h.nextEventID()
	meta := map[string]any{}
	for _, k := range []string{"kind", "code", "message", "retryable", "hint"} {
		if v, ok := payload[k]; ok {
			meta[k] = v
		}
	}
	if cutBy != "" {
		meta["cut_by"] = cutBy
	}
	h.publishRow(sid, "agent/turn-error", "turn-error", id, meta)
	typed := map[string]any{}
	for k, v := range payload {
		typed[k] = v
	}
	typed["event_id"] = id
	h.publishJSON(sid, "turn-error", typed)
}
