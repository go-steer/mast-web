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
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Turns that run because somebody asked for one (mock_play.go). Both
// halves of the bug a person found by running the walkthrough at a
// speed they could watch: a prompt produced no turn, and STOP could not
// end the turn that never came.

// attached opens a stream on sid and waits out the attach-time replay,
// whose last frame in newMockServer's fixture is a `turn-complete`.
// Waiting for it is also what proves the stream subscribed to the live
// topic, which it does before the replay starts: a POST made before
// that point is published to nobody.
func attached(t *testing.T, srv *httptest.Server, sid string) (<-chan sseFrame, func()) {
	t.Helper()
	frames, closeStream := openStream(t, srv, sid)
	awaitFrame(t, frames, "turn-complete")
	return frames, closeStream
}

// awaitTurnComplete waits for the turn-complete carrying promptID,
// skipping any other — the replay's own `p1` included.
func awaitTurnComplete(t *testing.T, frames <-chan sseFrame, promptID string) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case fr, ok := <-frames:
			if !ok {
				t.Fatalf("stream closed before turn-complete for %q", promptID)
			}
			if fr.Event == "turn-complete" && fr.Data["prompt_id"] == promptID {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for turn-complete for %q", promptID)
		}
	}
}

// eventually polls cond until it holds or a second passes. Play mode is
// timed by construction; this is the one place a test has to wait.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The bug: an inject answered with a wake and nothing else, so a
// prompt typed into the SPA never got a turn.
func TestMockPlay_AnInjectPlaysATurnAndItEnds(t *testing.T) {
	srv := newPlayingMockServer(t, 0)
	frames, closeStream := attached(t, srv, "smoke-session")
	defer closeStream()

	out := postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)
	promptID, _ := out["prompt_id"].(string)
	if promptID == "" {
		t.Fatalf("inject returned no prompt_id: %#v", out)
	}

	awaitFrame(t, frames, "wake")
	// The recorded turn, carrying THIS inject's id rather than the
	// fixture's `p1` — two turns that both said p1 would be one turn
	// to anything that correlates.
	awaitTurnComplete(t, frames, promptID)

	eventually(t, "the turn to end", func() bool {
		state, _, inFlight := statusOf(t, srv, "smoke-session")
		return state == "idle" && !inFlight
	})
}

// The other half: STOP's interrupt ended the turn in the mock's own
// state and told nobody, so the browser kept waiting for a terminal
// frame. A cancelled turn ends with a `canceled` turn-error (1.8.0).
func TestMockPlay_StopEndsThePlayingTurnWithCanceled(t *testing.T) {
	// Slow enough that the interrupt lands before the turn's first frame.
	srv := newPlayingMockServer(t, 200)
	frames, closeStream := attached(t, srv, "smoke-session")
	defer closeStream()

	out := postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)
	promptID, _ := out["prompt_id"].(string)
	awaitFrame(t, frames, "wake")

	res := postJSON(t, srv, "/sessions/smoke-session/interrupt", `{"hold":false}`)
	if res["interrupted"] != true {
		t.Fatalf("want interrupted:true mid-turn, got %#v", res)
	}

	fr := awaitFrame(t, frames, "turn-error")
	if fr.Data["kind"] != "canceled" || fr.Data["code"] != "CANCELED" || fr.Data["retryable"] != false {
		t.Fatalf("want the 1.8.0 canceled shape, got %#v", fr.Data)
	}

	// And the cut turn does not finish anyway behind the cancel.
	deadline := time.After(700 * time.Millisecond)
	for {
		select {
		case fr := <-frames:
			if fr.Event == "turn-complete" && fr.Data["prompt_id"] == promptID {
				t.Fatal("the cut turn completed after its cancel — two terminal frames for one turn")
			}
		case <-deadline:
			if _, _, inFlight := statusOf(t, srv, "smoke-session"); inFlight {
				t.Fatal("turn_in_flight still true after a cancel")
			}
			return
		}
	}
}

// Open mode had the same STOP bug, so the cancel frame is not a play-mode
// feature: whoever cuts a turn, the turn says it ended.
func TestMockPlay_StopSendsCanceledInOpenModeToo(t *testing.T) {
	srv := newMockServer(t) // open
	frames, closeStream := attached(t, srv, "smoke-session")
	defer closeStream()

	postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)
	postJSON(t, srv, "/sessions/smoke-session/interrupt", `{"hold":false}`)

	fr := awaitFrame(t, frames, "turn-error")
	if fr.Data["kind"] != "canceled" {
		t.Fatalf("want canceled, got %#v", fr.Data)
	}
}

// Nothing in flight, nothing to end: a stray STOP must not invent a
// cancellation for a turn that was never there.
func TestMockPlay_StopWithNothingInFlightSendsNothing(t *testing.T) {
	srv := newPlayingMockServer(t, 0)
	frames, closeStream := attached(t, srv, "smoke-session")
	defer closeStream()

	res := postJSON(t, srv, "/sessions/smoke-session/interrupt", `{"hold":false}`)
	if res["interrupted"] != false {
		t.Fatalf("want interrupted:false with nothing running, got %#v", res)
	}
	select {
	case fr := <-frames:
		if fr.Event == "turn-error" {
			t.Fatalf("a cancel for no turn: %#v", fr.Data)
		}
	case <-time.After(200 * time.Millisecond):
	}
}

// Without this, CONTINUE left the status bar reading "1 running" for
// the rest of the session: resume marked a turn in flight and nothing
// in play mode or open mode ever ended it.
func TestMockPlay_ContinueRunsATurnThatEnds(t *testing.T) {
	srv := newPlayingMockServer(t, 0)
	frames, closeStream := attached(t, srv, "smoke-session")
	defer closeStream()

	postJSON(t, srv, "/sessions/smoke-session/pause", `{}`)
	postJSON(t, srv, "/sessions/smoke-session/resume", `{"mode":"continue"}`)
	awaitFrame(t, frames, "wake")

	eventually(t, "the continued turn to end", func() bool {
		state, _, inFlight := statusOf(t, srv, "smoke-session")
		return state == "idle" && !inFlight
	})
}

// The switch itself: open is required on POST, DELETE puts play back.
func TestMockPlay_TheSwitch(t *testing.T) {
	srv := newPlayingMockServer(t, 0)
	if got := getJSON(t, srv, "/_mock/turns"); got["open"] != false {
		t.Fatalf("default should be play, got %#v", got)
	}

	resp, err := http.Post(srv.URL+"/_mock/turns", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("POST without open: want 400, got %d", resp.StatusCode)
	}

	postJSON(t, srv, "/_mock/turns", `{"open":true}`)
	postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)
	time.Sleep(50 * time.Millisecond)
	if _, _, inFlight := statusOf(t, srv, "smoke-session"); !inFlight {
		t.Fatal("open mode: an injected turn ended on its own")
	}

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/_mock/turns", nil)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got := getJSON(t, srv, "/_mock/turns"); got["open"] != false {
		t.Fatalf("DELETE should reset to play, got %#v", got)
	}
}
