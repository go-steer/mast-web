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
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The operator pause gate, protocol v1.5.0 — core-agent
// pkg/attach/pause.go and docs/operator-interrupt-design.md.
//
// Every other mutation the mock serves is a no-op that returns {}. This
// one can't be, because the whole point of the gate is that it has a
// before and an after: /interrupt parks the loop, the session refuses
// to start a turn, and /resume opens it again. A stub that always
// answers "fine" models the one state where the feature is invisible,
// which is exactly how we shipped a Stop button that parked sessions in
// production without a single test noticing (#68).
//
// So the mock keeps real state and emits real `pause` frames on the
// live SSE stream. Not a simulation of the agent — there is no loop
// here to stop — but a faithful model of the gate's observable
// behaviour, which is all a consumer can see anyway.

// Pause states carried on the `pause` event's `state` field
// (core-agent pkg/attach/events.go, PauseState* constants).
const (
	pauseStatePaused  = "paused"
	pauseStateResumed = "resumed"
)

// Resume dispositions (core-agent ResumeMode* constants). `steer`
// carries a new instruction, `continue` says carry on where you left
// off, `abandon` opens the gate without injecting anything.
const (
	resumeModeSteer    = "steer"
	resumeModeContinue = "continue"
	resumeModeAbandon  = "abandon"
)

// defaultPauseReason is what core-agent stamps on a gate closed by a
// bare /pause or /interrupt with no reason given.
const defaultPauseReason = "operator paused"

// ─── Gate state ──────────────────────────────────────────────────────

// pauseGate is one session's gate. Zero value is the open gate, so an
// unknown session reads as "not paused" without needing to be created.
type pauseGate struct {
	paused bool
	since  time.Time
	reason string
	// interrupted records whether a turn was cancelled on the way into
	// this pause — the difference between "your work was killed" and
	// "the loop just won't start", which is the first thing an operator
	// asks. Carried on the pause event and on GET /status.
	interrupted bool
	// turnInFlight is the mock's model of a turn actually executing.
	//
	// It exists for v1.12.0 (core-agent#896), which made `state:
	// "running"` reachable and added `turn_in_flight` beside it. Both
	// are unmodellable without SOMETHING here that starts and stops,
	// and a mock that can only ever answer "idle" teaches a consumer
	// that running doesn't happen — which is the shape of the bug
	// #896 itself was: a state declared from the start and never
	// produced, so every client's mid-turn path went untested.
	//
	// The transitions:
	//
	//   inject / wake, gate open   → true   (a turn starts)
	//   inject / wake, gate closed → unchanged (queued behind it)
	//   interrupt, hold=false      → false  (cancelled, loop free; a
	//                                `canceled` turn-error is sent)
	//   interrupt, hold=true       → open mode: unchanged — THE
	//                                INTERESTING ONE. A turn cancelled
	//                                on the way into a hold is still
	//                                unwinding, which is the paused-
	//                                and-running window the bool was
	//                                added to express.
	//                                play mode: false, with `canceled`.
	//   pause                      → unchanged (a quiet hold over a
	//                                running turn is a real state)
	//   resume steer               → true   (the correction runs)
	//   resume continue            → true if a message was queued
	//                                behind the gate or a turn was
	//                                still in flight; otherwise false
	//                                (nothing held, nothing to resume)
	//   resume abandon             → false  (gate open, work dropped)
	//   a played turn runs out     → false  (play mode only)
	//
	// In open mode (POST /_mock/turns {"open":true}) nothing clears it
	// on its own and every transition is deliberate rather than timed,
	// so a test never races them; the Go tests run that way. In play
	// mode, the default, a started turn plays the fixture and ends. See
	// mock_play.go for why both exist.
	turnInFlight bool
	// queued records that a message arrived while the gate was closed
	// and is waiting behind it. It is the difference between a continue
	// that has held work to resume and one that just opens the gate:
	// without it the mock could only guess, and guessing "yes" played a
	// turn nobody asked for every time an operator pressed CONTINUE.
	queued bool
}

// pauseGates holds every session's gate. Sessions are created lazily:
// the mock has no session lifecycle to hook, and an absent entry and an
// open gate are the same thing.
type pauseGates struct {
	mu sync.Mutex
	m  map[string]pauseGate
}

func (g *pauseGates) get(sid string) pauseGate {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.m[sid]
}

// set stores the gate and reports the previous paused flag, so callers
// can tell whether they were the transition or a redundant press.
func (g *pauseGates) set(sid string, next pauseGate) (wasPaused bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.m == nil {
		g.m = make(map[string]pauseGate)
	}
	wasPaused = g.m[sid].paused
	g.m[sid] = next
	return wasPaused
}

// reset clears every gate. Used by the test-only reset endpoint so a
// spec can start from a known state without restarting the server.
func (g *pauseGates) reset() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.m = make(map[string]pauseGate)
}

// resetGates backs DELETE /_mock/pause-gates. Test-only, like the
// turn-request tally it sits next to; the underscore marks it as the
// mock's own rather than anything a real backend serves.
func (h *mockHandler) resetGates(w http.ResponseWriter, _ *http.Request) {
	h.turns.stopAll()
	h.gates.reset()
	writeEmpty(w, http.StatusNoContent)
}

// ─── Live-stream fan-out ─────────────────────────────────────────────

// mockHub delivers frames produced by a POST handler to the SSE streams
// already open on that session.
//
// Without this the gate would be invisible to a consumer: the pause
// event is how a client learns the session parked, and a client that
// only ever sees fixture replay can never be tested against a pause it
// caused itself. Keyed by session ID because that is the granularity
// the protocol broadcasts at — every attached client sees every other
// operator's pause, which is the point of a shared session.
type mockHub struct {
	mu   sync.Mutex
	subs map[string]map[chan frame]struct{}
}

// subscribe registers a listener for one session and returns it with
// its own unsubscribe. The channel is buffered so a publisher never
// waits on a reader that is mid-flush.
func (b *mockHub) subscribe(sid string) (<-chan frame, func()) {
	// Deep enough for a whole played turn (mock_play.go) to queue
	// behind an attach-time replay that is still draining.
	ch := make(chan frame, 64)
	b.mu.Lock()
	if b.subs == nil {
		b.subs = make(map[string]map[chan frame]struct{})
	}
	if b.subs[sid] == nil {
		b.subs[sid] = make(map[chan frame]struct{})
	}
	b.subs[sid][ch] = struct{}{}
	b.mu.Unlock()

	return ch, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if set, ok := b.subs[sid]; ok {
			delete(set, ch)
			if len(set) == 0 {
				delete(b.subs, sid)
			}
		}
	}
}

// publish fans a frame out to every live subscriber. Drops rather than
// blocks when a subscriber's buffer is full: a browser tab that stopped
// reading must not be able to wedge the POST handler that is trying to
// tell it something.
func (b *mockHub) publish(sid string, fr frame) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs[sid] {
		select {
		case ch <- fr:
		default:
		}
	}
}

// pauseFrame builds the `pause` SSE frame for a gate transition.
// core-agent's PauseEvent: {state, reason?, interrupted?, mode?, at}.
func pauseFrame(state, reason, mode string, interrupted bool, at time.Time) frame {
	payload := map[string]any{
		"state": state,
		"at":    at.UTC().Format(time.RFC3339Nano),
	}
	if reason != "" {
		payload["reason"] = reason
	}
	if interrupted {
		payload["interrupted"] = true
	}
	if mode != "" {
		payload["mode"] = mode
	}
	data, _ := json.Marshal(payload)
	return frame{Event: "pause", Data: data}
}

// wakeFrame builds the `wake` SSE frame (v1.7.0). The payload is just a
// timestamp on purpose — a wake says "look now" and nothing else; what
// woke the loop reports itself through its own frames.
func wakeFrame(at time.Time) frame {
	data, _ := json.Marshal(map[string]any{"at": at.UTC().Format(time.RFC3339Nano)})
	return frame{Event: "wake", Data: data}
}

// ─── Handlers ────────────────────────────────────────────────────────

// interruptRequest is the POST body for /interrupt. Hold is a pointer
// for the same reason core-agent's is: an omitted field means hold,
// which is NOT the same as an explicit false. Getting this wrong on the
// client side is #68.
type interruptRequest struct {
	Hold          *bool `json:"hold"`
	StopSubagents bool  `json:"stop_subagents"`
}

// interrupt models POST /sessions/.../interrupt at v1.5.0 semantics:
// cancel the in-flight turn, and — unless the caller explicitly says
// otherwise — park the loop behind the gate.
//
// Both halves are real now. Whether there was a turn to cancel is
// pauseGate.turnInFlight, which an inject or a wake sets: the mock
// still has no loop, but it has a model of one, and `interrupted`
// answering a constant false made the whole cancelled-mid-hold case
// (v1.12.0 #896) untestable.
func (h *mockHandler) interrupt(w http.ResponseWriter, r *http.Request, sid string) {
	var req interruptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// Empty or malformed body. Empty is explicitly valid and means
		// hold, so the zero value is already the right answer.
		req = interruptRequest{}
	}
	// The v1.5.0 default flip, verbatim from core-agent handlers.go:
	// an absent flag means hold.
	hold := req.Hold == nil || *req.Hold

	// Whatever is playing stops here, held or not: both forms cancel
	// the turn. What differs is whether it has finished unwinding.
	h.turns.stop(sid)
	prev := h.gates.get(sid)
	interrupted := prev.turnInFlight
	// In play mode a cut turn ends: there is no loop left to unwind
	// it, and a turn the mock leaves in flight forever is a turn the
	// browser waits on forever. Open mode keeps the unwind window
	// below, because smoke/022 is about exactly that window.
	ends := interrupted && !h.turns.isOpen()

	now := time.Now()
	if hold {
		// turnInFlight rides through the hold rather than being cleared
		// by it: a cancelled turn takes time to unwind, and "parked,
		// and the thing you killed is still running" is exactly the
		// window #896 added a field for.
		gate := pauseGate{
			paused:       true,
			since:        now,
			reason:       defaultPauseReason,
			interrupted:  interrupted,
			turnInFlight: prev.turnInFlight && !ends,
			queued:       prev.queued,
		}
		if prev.paused {
			// Don't restamp a gate that was already closed.
			gate.since = prev.since
			gate.reason = prev.reason
			gate.interrupted = prev.interrupted || interrupted
		}
		if ends {
			h.perms.cancelPending(sid)
			h.publishTurnError(sid, canceledPayload(), "")
		}
		if wasPaused := h.gates.set(sid, gate); !wasPaused {
			h.hub.publish(sid, pauseFrame(pauseStatePaused, gate.reason, "", gate.interrupted, now))
		}
	} else {
		// Cancel only. The turn is gone and the loop is free to start
		// another one, which is what makes this the safe Stop (#73).
		next := prev
		next.turnInFlight = false
		h.gates.set(sid, next)
		// And the turn says so. A real daemon ends a cancelled turn with
		// a `canceled` turn-error (1.8.0); without it the browser's STOP
		// clears the server's state and leaves the composer waiting on a
		// terminal frame that is never sent.
		if interrupted {
			h.perms.cancelPending(sid)
			h.publishTurnError(sid, canceledPayload(), "")
		}
	}

	for k, v := range corsHeaders() {
		w.Header().Set(k, v)
	}
	// Pre-v1.5.0 consumers read the header and never look at the body.
	// Keep it accurate rather than dropping it — a consumer that hasn't
	// caught up should still get a true answer to the question it knows
	// how to ask.
	if interrupted {
		w.Header().Set("X-Interrupted", "yes")
	} else {
		w.Header().Set("X-Interrupted", "nothing-in-flight")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session":     sid,
		"interrupted": interrupted,
		"paused":      h.gates.get(sid).paused,
	})
}

// pause models POST /sessions/.../pause (v1.5.0) — close the gate with
// no cancel. Idempotent: a redundant press returns 200 with
// transitioned:false so a second operator surface racing the same click
// can stay quiet instead of reporting a failure.
func (h *mockHandler) pause(w http.ResponseWriter, r *http.Request, sid string) {
	var req struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	reason := req.Reason
	if reason == "" {
		reason = defaultPauseReason
	}

	now := time.Now()
	prev := h.gates.get(sid)
	// A /pause cancels nothing, so a turn already running keeps running
	// behind the closed gate — the quiet-hold-over-a-live-turn case.
	gate := pauseGate{
		paused:       true,
		since:        now,
		reason:       reason,
		interrupted:  prev.interrupted,
		turnInFlight: prev.turnInFlight,
		queued:       prev.queued,
	}
	if prev.paused {
		// Already closed — don't restamp `since`, an operator watching
		// "paused for 4m" shouldn't see it jump back to zero because
		// someone pressed again.
		gate.since = prev.since
		gate.reason = prev.reason
	}
	h.gates.set(sid, gate)
	if !prev.paused {
		h.hub.publish(sid, pauseFrame(pauseStatePaused, gate.reason, "", gate.interrupted, now))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"session":      sid,
		"paused":       true,
		"transitioned": !prev.paused,
		"state":        pauseStatePaused,
		"paused_since": gate.since.UTC().Format(time.RFC3339Nano),
		"pause_reason": gate.reason,
	})
}

// resume models POST /sessions/.../resume (v1.5.0) — open the gate with
// a disposition. Mode defaults to "steer" when steer text is present
// and "continue" otherwise, so a client can send just {"steer": "..."}
// or an empty body.
//
// Resuming a session that isn't paused is a 200 with resumed:false, not
// an error, for the same idempotency reason /pause has.
//
// The two 400s are modelled rather than waved through. Upstream rejects
// an unknown mode and a steer with no text (handlers_pause.go:105-115),
// and a mock that accepted both would let a client ship a steer box
// that submits empty and only fails against a real backend — which is
// the exact class of bug the drift guard in mock_spec_test.go exists
// for. Refusing here is what makes the client's own validation
// testable.
func (h *mockHandler) resume(w http.ResponseWriter, r *http.Request, sid string) {
	var req struct {
		Mode  string `json:"mode"`
		Steer string `json:"steer"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	req.Steer = strings.TrimSpace(req.Steer)
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	switch mode {
	case "", resumeModeSteer, resumeModeContinue, resumeModeAbandon:
	default:
		writeError(w, http.StatusBadRequest,
			"resume: unknown mode "+strconv.Quote(mode)+" (want steer, continue, or abandon)\n")
		return
	}
	if mode == resumeModeSteer && req.Steer == "" {
		writeError(w, http.StatusBadRequest, "resume: mode=steer requires non-empty 'steer' text\n")
		return
	}
	if mode == "" {
		if req.Steer != "" {
			mode = resumeModeSteer
		} else {
			mode = resumeModeContinue
		}
	}

	prev := h.gates.get(sid)
	// What happens to the held work, by mode:
	//
	//   steer    — a new turn, always: the correction IS work, and it
	//              runs whatever was or wasn't waiting.
	//   continue — resumes what was held and nothing more. A message
	//              queued behind the gate runs; a turn still in flight
	//              carries on; and with neither, the gate opens on an
	//              idle session. Inventing a turn here played the
	//              fixture at an operator who had paused an idle
	//              session and pressed CONTINUE.
	//   abandon  — drops all of it, leaving the session idle.
	stillRunning := prev.turnInFlight && mode != resumeModeAbandon
	newTurn := prev.paused &&
		(mode == resumeModeSteer || (mode == resumeModeContinue && prev.queued && !prev.turnInFlight))
	h.gates.set(sid, pauseGate{turnInFlight: stillRunning})
	if mode == resumeModeAbandon {
		h.turns.stop(sid)
	}
	now := time.Now()
	if prev.paused {
		h.hub.publish(sid, pauseFrame(pauseStateResumed, "", mode, false, now))
		// The loop going back to work is signalled with a wake (v1.7.0).
		// Only when it actually does: a continue with nothing held, and
		// an abandon, open the gate on an idle session.
		if newTurn || stillRunning {
			h.hub.publish(sid, wakeFrame(now))
		}
	}
	if newTurn {
		// In play mode the work actually runs and ends (mock_play.go);
		// in open mode it stays in flight until something stops it.
		h.startTurn(sid, "")
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"session": sid,
		"resumed": prev.paused,
		"mode":    mode,
		"state":   pauseStateResumed,
	})
}
