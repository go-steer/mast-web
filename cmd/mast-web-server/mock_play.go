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
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// A turn that runs because somebody asked for one.
//
// Until this file the mock replayed its fixture once, when a stream
// opened, and answered every inject with a `wake` frame and nothing
// else. So a prompt typed into the SPA never produced a turn: whatever
// closed the browser's turn was the attach-time replay happening to
// still be draining when the prompt went out. At the default 150ms
// pacing that was usually true and nobody noticed. At 800ms — slowed
// down so a person could watch the stream — the replay finished before
// anyone typed, the prompt opened a turn that nothing would ever close,
// and STOP could not close it either, because the interrupt handler
// cleared its own state and published no `canceled` frame. The first
// person to run docs/walkthrough.md §1 at a watchable speed hit both.
//
// Two modes, because the suite needs both kinds of turn:
//
//   play (default) — an inject, or a resume that puts the loop back to
//                    work, plays the server fixture's turn on the live
//                    stream at the configured pace, then the turn ends.
//                    What a real daemon does, and what an operator at
//                    the composer expects.
//   open           — the turn starts and stays in flight until
//                    something stops it: interrupt, abandon, or a gate
//                    reset. The mock's original model, kept for the
//                    cases that are ABOUT a turn somebody else is
//                    running (smoke/022, walkthrough §6): a turn that
//                    finished in 100ms could not be watched arriving
//                    in a status poll ten seconds later.
//
// Switched at POST /_mock/turns {"open": bool}; DELETE resets to play.
// Process-wide rather than per session because the suite is serial
// (one worker against one server) and a spec that sets it clears it.

// mockTurns tracks the turn playing on each session, so an interrupt
// can cut it short, and the process-wide open/play switch.
type mockTurns struct {
	mu      sync.Mutex
	open    bool
	playing map[string]*playback
}

// playback is one turn's identity. A pointer, so a playback that ran
// to completion can tell whether it is still the current one before
// it clears turn state — an interrupt, or a newer turn, may already
// have replaced it.
type playback struct {
	cancel context.CancelFunc
}

func (t *mockTurns) isOpen() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.open
}

// begin registers a new playback for sid, cancelling any still running
// there: one session runs one turn at a time.
func (t *mockTurns) begin(sid string) (context.Context, *playback) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.playing == nil {
		t.playing = make(map[string]*playback)
	}
	if prev := t.playing[sid]; prev != nil {
		prev.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &playback{cancel: cancel}
	t.playing[sid] = p
	return ctx, p
}

// stop cuts sid's playback short. Reports whether one was running.
func (t *mockTurns) stop(sid string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	p := t.playing[sid]
	if p == nil {
		return false
	}
	p.cancel()
	delete(t.playing, sid)
	return true
}

// finish retires p if it is still sid's current playback, and reports
// whether it was. Called by a playback that reached its last frame,
// under the same lock stop uses, so "ran out" and "was cut" cannot
// both claim the ending.
func (t *mockTurns) finish(sid string, p *playback) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.playing[sid] != p {
		return false
	}
	delete(t.playing, sid)
	return true
}

func (t *mockTurns) stopAll() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for sid, p := range t.playing {
		p.cancel()
		delete(t.playing, sid)
	}
}

// setTurns backs /_mock/turns. GET reports the mode, POST sets it,
// DELETE resets to play and stops anything playing.
func (h *mockHandler) setTurns(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var req struct {
			Open *bool `json:"open"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		drainBody(r)
		if req.Open == nil {
			writeError(w, http.StatusBadRequest, `turns: "open" is required`+"\n")
			return
		}
		h.turns.mu.Lock()
		h.turns.open = *req.Open
		h.turns.mu.Unlock()
	case http.MethodDelete:
		h.turns.stopAll()
		h.turns.mu.Lock()
		h.turns.open = false
		h.turns.mu.Unlock()
	}
	writeJSON(w, http.StatusOK, map[string]any{"open": h.turns.isOpen()})
}

// startTurn marks sid's turn in flight and, in play mode, plays the
// server fixture's turn on the live stream. Callers have already
// decided a turn starts (gate open, loop woken).
func (h *mockHandler) startTurn(sid, promptID string) {
	gate := h.gates.get(sid)
	gate.turnInFlight = true
	h.gates.set(sid, gate)
	if h.turns.isOpen() {
		return
	}
	frames := h.turnFrames(promptID)
	ctx, p := h.turns.begin(sid)
	go h.play(ctx, p, sid, frames)
}

// turnFrames is the server fixture minus what belongs to the stream
// rather than the turn. The fixture is the server default (--fixture),
// not a session's attach-time pin: those exist so panels look distinct
// when they open, and a turn an operator asked for should look like a
// turn regardless of which session it was asked of.
func (h *mockHandler) turnFrames(promptID string) []frame {
	all, err := loadFixture(h.fixturesDir, h.fixture)
	if err != nil {
		return nil
	}
	out := make([]frame, 0, len(all))
	for _, fr := range all {
		if fr.Event == "capabilities" {
			continue
		}
		out = append(out, withPromptID(fr, promptID))
	}
	return out
}

// withPromptID rewrites a recorded prompt_id to the one this inject
// was given (v1.10.0, core-agent#840). A replayed `p1` on every turn
// would make two turns indistinguishable to anything that correlates.
func withPromptID(fr frame, promptID string) frame {
	if promptID == "" {
		return fr
	}
	var data map[string]any
	if json.Unmarshal(fr.Data, &data) != nil {
		return fr
	}
	if _, ok := data["prompt_id"]; !ok {
		return fr
	}
	data["prompt_id"] = promptID
	b, err := json.Marshal(data)
	if err != nil {
		return fr
	}
	return frame{Event: fr.Event, Data: b}
}

// play publishes frames at the configured pace. A playback that runs
// out ends its turn; one that is cut leaves the ending to whoever cut
// it, which is the interrupt handler's job (mock_pause.go).
func (h *mockHandler) play(ctx context.Context, p *playback, sid string, frames []frame) {
	delay := time.Duration(h.frameDelayMs) * time.Millisecond
	for _, fr := range frames {
		if delay > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
		} else if ctx.Err() != nil {
			return
		}
		h.hub.publish(sid, fr)
	}
	if h.turns.finish(sid, p) {
		gate := h.gates.get(sid)
		gate.turnInFlight = false
		h.gates.set(sid, gate)
	}
}

// canceledFrame is the terminal frame a cancelled turn ends with
// (protocol 1.8.0, core-agent#816): kind `canceled`, code `CANCELED`,
// and not retryable, because re-running work an operator just stopped
// is the opposite of what they asked for. Payload per core-tui's
// sse-event-stream-protocol.md §2.6.
func canceledPayload() map[string]any {
	return map[string]any{
		"kind":      "canceled",
		"code":      "CANCELED",
		"message":   "turn canceled",
		"retryable": false,
	}
}
