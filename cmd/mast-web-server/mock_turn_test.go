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
	"strings"
	"testing"
	"time"
)

// The turn model: v1.11.0's hold that an inject no longer opens
// (core-agent#878), v1.12.0's reachable `running` and the
// `turn_in_flight` field that made it reachable (#896), and the honest
// subagent stop (#897).
//
// These three landed together because they are one story: through
// 1.10.0 a client could not tell a parked session from a busy one, and
// typing at a parked session appeared to fix it. The mock has to be
// able to be wrong in the old way for a test to prove we handle the
// new one.

// statusOf reads GET /status and returns the three fields the banner
// is built out of.
func statusOf(t *testing.T, srv *httptest.Server, sid string) (state string, turnState string, inFlight bool) {
	t.Helper()
	st := getJSON(t, srv, "/sessions/"+sid+"/status")
	state, _ = st["state"].(string)
	turnState, _ = st["turn_state"].(string)
	inFlight, _ = st["turn_in_flight"].(bool)
	return state, turnState, inFlight
}

// ─── v1.11.0: an inject does not open the gate ───────────────────────

// The behaviour change, and the one with a live bug behind it: before
// #878, typing into a held session released the hold. An operator who
// paused to read a diff got their session un-paused by the very
// message they were composing about it.
func TestMockTurn_InjectDoesNotReleaseAHold(t *testing.T) {
	srv := newMockServer(t)
	frames, closeStream := openStream(t, srv, "smoke-session")
	defer closeStream()

	postJSON(t, srv, "/sessions/smoke-session/pause", `{"reason":"reading the diff"}`)
	awaitFrame(t, frames, "pause")

	out := postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"and another thing"}`)
	// The message is accepted and queued — that part never changed, and
	// a client that refused to send while held would be worse than the
	// bug.
	if out["injected"] != "and another thing" {
		t.Fatalf("want the message accepted, got %#v", out)
	}
	// `woke` reports the DELIVERY THE CALLER ASKED FOR, not what the
	// gate allowed — upstream sets it straight off the request flag on
	// both paths. The gate is reported by /status, and conflating the
	// two here would make the mock disagree with core-agent about the
	// one field #698 added.
	if out["woke"] != true {
		t.Fatalf("want woke:true echoing the requested delivery, got %#v", out["woke"])
	}

	// But the hold is still a hold.
	state, _, inFlight := statusOf(t, srv, "smoke-session")
	if state != "paused" {
		t.Fatalf("state = %q after an inject into a held session, want it still paused", state)
	}
	if inFlight {
		t.Fatal("the inject started a turn behind a closed gate")
	}

	// And no wake reached the stream. The resume's frame is the marker:
	// both publishes would be ordered before it, so reading until it
	// arrives and failing on a wake along the way is a real check
	// rather than a sleep.
	postJSON(t, srv, "/sessions/smoke-session/resume", `{"mode":"continue"}`)
	deadline := time.After(3 * time.Second)
	for {
		select {
		case fr, ok := <-frames:
			if !ok {
				t.Fatal("stream closed before the resume frame arrived")
			}
			if fr.Event == "wake" {
				t.Fatal("the inject published a wake at a held session (pre-v1.11.0 behaviour)")
			}
			if fr.Event == "pause" && fr.Data["state"] == pauseStateResumed {
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for the resume frame")
		}
	}
}

// wake:false (#698) is the other way to inject without starting a turn,
// and it is available while the gate is OPEN — which is what makes it
// different from the case above.
func TestMockTurn_WakeFalseQueuesWithoutStartingATurn(t *testing.T) {
	srv := newMockServer(t)

	out := postJSON(t, srv, "/sessions/smoke-session/inject",
		`{"message":"for whenever you next run","wake":false}`)
	if out["woke"] != false {
		t.Fatalf("want woke:false echoed, got %#v", out["woke"])
	}
	if state, _, inFlight := statusOf(t, srv, "smoke-session"); inFlight || state != "idle" {
		t.Fatalf("a deferred inject started a turn: state=%q in_flight=%v", state, inFlight)
	}

	// A deferred message still drains into some turn, so it still names
	// a prompt id (#840) — a client keying per-turn state needs the
	// handle on both paths.
	if id, _ := out["prompt_id"].(string); id == "" {
		t.Fatalf("want a prompt_id on the deferred path too, got %#v", out["prompt_id"])
	}
}

// #840: the id is per-message, and a client keying placeholder state by
// it would collapse two messages onto one if the mock reused it.
func TestMockTurn_PromptIDIsPerMessage(t *testing.T) {
	srv := newMockServer(t)
	first := postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"one"}`)
	second := postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"two"}`)
	a, _ := first["prompt_id"].(string)
	b, _ := second["prompt_id"].(string)
	if a == "" || b == "" {
		t.Fatalf("want a prompt_id on each inject, got %q and %q", a, b)
	}
	if a == b {
		t.Fatalf("both injects were named %q", a)
	}

	// A BARE wake queues nothing, so it names nothing. `omitempty`
	// upstream: there is no informative empty id.
	bare := postJSON(t, srv, "/sessions/smoke-session/wake", `{}`)
	if _, present := bare["prompt_id"]; present {
		t.Fatalf("a bare wake reported prompt_id %#v, want the key absent", bare["prompt_id"])
	}
}

// ─── v1.12.0: `running` is reachable, and separate from paused ───────

// The state a mock at 1.7.0 could never produce. Until #896 the field
// existed in the spec and nothing we could run would ever emit it, so
// the SPA's `running` branch was dead code nobody had exercised.
func TestMockTurn_RunningIsReachable(t *testing.T) {
	srv := newMockServer(t)

	if state, _, inFlight := statusOf(t, srv, "smoke-session"); state != "idle" || inFlight {
		t.Fatalf("a fresh session: state=%q in_flight=%v, want idle and false", state, inFlight)
	}

	postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)

	state, turnState, inFlight := statusOf(t, srv, "smoke-session")
	if state != "running" {
		t.Fatalf("state = %q with a turn in flight, want running", state)
	}
	if turnState != "streaming" {
		t.Fatalf("turn_state = %q, want streaming", turnState)
	}
	if !inFlight {
		t.Fatal("turn_in_flight = false with a turn in flight")
	}
}

// Why #896 needed a SEPARATE field rather than another `state` value.
// `state` has one slot and pause outranks running in it, so "parked,
// and the turn you cancelled is still unwinding" has no spelling
// without turn_in_flight — and that window is exactly when an operator
// is staring at the screen wondering whether Stop worked.
func TestMockTurn_PauseOutranksRunningSoTheFieldIsSeparate(t *testing.T) {
	srv := newMockServer(t)

	postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)
	postJSON(t, srv, "/sessions/smoke-session/pause", `{"reason":"hold on"}`)

	state, turnState, inFlight := statusOf(t, srv, "smoke-session")
	if state != "paused" || turnState != "paused" {
		t.Fatalf("state=%q turn_state=%q, want the pause to win the one-field state", state, turnState)
	}
	if !inFlight {
		t.Fatal("turn_in_flight went false at a pause — a pause does not cancel the turn, " +
			"and the client cannot see the mid-turn park without this field")
	}
}

// The interrupt's two dispositions, which differ in what they do to the
// TURN and not only to the gate.
func TestMockTurn_InterruptCancelsTheTurnBothWays(t *testing.T) {
	t.Run("hold:false cancels and leaves the loop free", func(t *testing.T) {
		srv := newMockServer(t)
		postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)

		out := postJSON(t, srv, "/sessions/smoke-session/interrupt", `{"hold":false}`)
		if out["interrupted"] != true {
			t.Fatalf("want interrupted:true — there WAS a turn — got %#v", out["interrupted"])
		}
		state, _, inFlight := statusOf(t, srv, "smoke-session")
		if inFlight || state != "idle" {
			t.Fatalf("state=%q in_flight=%v, want the turn gone and the gate open", state, inFlight)
		}
	})

	t.Run("hold:true parks with the turn still unwinding", func(t *testing.T) {
		srv := newMockServer(t)
		postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)

		out := postJSON(t, srv, "/sessions/smoke-session/interrupt", `{}`)
		if out["interrupted"] != true || out["paused"] != true {
			t.Fatalf("want interrupted+paused for the v1.5.0 default, got %#v", out)
		}
		if _, _, inFlight := statusOf(t, srv, "smoke-session"); !inFlight {
			t.Fatal("turn_in_flight cleared instantly on a held cancel; the unwind window is the " +
				"whole reason #896 exists")
		}
	})
}

// The legacy header has to track the new truth, not a constant. A
// pre-v1.5.0 consumer reads only this, and `nothing-in-flight` after
// cancelling a real turn is the wrong answer to the one question it
// knows how to ask.
func TestMockTurn_LegacyHeaderReportsWhetherThereWasATurn(t *testing.T) {
	srv := newMockServer(t)

	interruptHeader := func() string {
		t.Helper()
		resp, err := http.Post(srv.URL+"/sessions/smoke-session/interrupt",
			"application/json", strings.NewReader(`{"hold":false}`))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.Header.Get("X-Interrupted")
	}

	if got := interruptHeader(); got != "nothing-in-flight" {
		t.Fatalf("idle session: X-Interrupted = %q, want nothing-in-flight", got)
	}
	postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)
	if got := interruptHeader(); got != "yes" {
		t.Fatalf("mid-turn: X-Interrupted = %q, want yes", got)
	}
}

// Resume's three modes differ in whether a turn comes back, which is
// the difference an operator is actually choosing between.
func TestMockTurn_ResumeModeDecidesWhetherATurnFollows(t *testing.T) {
	for _, tc := range []struct {
		body      string
		wantState string
	}{
		{`{"mode":"continue"}`, "running"},
		{`{"mode":"steer","steer":"try the other branch"}`, "running"},
		// Abandon drops the turn on the floor. That is the mode's
		// entire point, and a client that showed a spinner afterwards
		// would be waiting for output that is never coming.
		{`{"mode":"abandon"}`, "idle"},
	} {
		t.Run(tc.body, func(t *testing.T) {
			srv := newMockServer(t)
			postJSON(t, srv, "/sessions/smoke-session/pause", `{}`)
			postJSON(t, srv, "/sessions/smoke-session/resume", tc.body)

			state, _, inFlight := statusOf(t, srv, "smoke-session")
			if state != tc.wantState {
				t.Fatalf("state = %q, want %q", state, tc.wantState)
			}
			if inFlight != (tc.wantState == "running") {
				t.Fatalf("turn_in_flight = %v, want %v", inFlight, tc.wantState == "running")
			}
		})
	}
}

// The two 400s the mock was missing. A steer box validated only against
// a permissive mock ships a client that sends empty steer text and
// finds out in production.
func TestMockTurn_ResumeRejectsIncoherentRequests(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"unknown mode", `{"mode":"unpause"}`},
		{"steer with no text", `{"mode":"steer"}`},
		{"steer with only whitespace", `{"mode":"steer","steer":"   "}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newMockServer(t)
			postJSON(t, srv, "/sessions/smoke-session/pause", `{}`)

			resp, err := http.Post(srv.URL+"/sessions/smoke-session/resume",
				"application/json", strings.NewReader(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("want 400, got %d", resp.StatusCode)
			}
			// A refused resume must not half-happen.
			if st := getJSON(t, srv, "/sessions/smoke-session/status"); st["paused"] != true {
				t.Fatal("a rejected resume opened the gate anyway")
			}
		})
	}
}

// ─── v1.12.0 #897: an honest subagent stop ───────────────────────────

// `stopped` used to mean "the name is registered" and now means "THIS
// CALL halted it". The 200/false case is the one that changed: an
// operator was previously told they stopped something that had
// finished thirty seconds earlier.
func TestMockTurn_StopSubagentReportsWhoDidTheStopping(t *testing.T) {
	srv := newMockServer(t)

	t.Run("a live subagent", func(t *testing.T) {
		var live string
		for _, name := range knownSubagentNames {
			if name != finishedSubagentName {
				live = name
				break
			}
		}
		if live == "" {
			t.Skip("the fixture catalog has no running subagent")
		}
		out := postJSON(t, srv, "/sessions/smoke-session/agents/"+live+"/stop", `{}`)
		if out["stopped"] != true {
			t.Fatalf("want stopped:true for a running subagent, got %#v", out)
		}
		if out["status"] != "stopped" {
			t.Fatalf("status = %#v, want stopped", out["status"])
		}
	})

	t.Run("one that already finished", func(t *testing.T) {
		out := postJSON(t, srv,
			"/sessions/smoke-session/agents/"+finishedSubagentName+"/stop", `{}`)
		if out["stopped"] != false {
			t.Fatalf("want stopped:false — it stopped itself — got %#v", out["stopped"])
		}
		// The terminal status is how the client renders the truth. A 200
		// means "it is no longer running" either way, which is what the
		// operator needed to know.
		if out["status"] != "completed" {
			t.Fatalf("status = %#v, want the terminal status reported", out["status"])
		}
	})

	t.Run("a name nobody registered", func(t *testing.T) {
		resp, err := http.Post(srv.URL+"/sessions/smoke-session/agents/nobody/stop",
			"application/json", strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		// 404 keeps its narrow trigger. A finished subagent is NOT a 404:
		// it existed, the operator aimed correctly, and there is nothing
		// to retry.
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("want 404 for an unregistered name, got %d", resp.StatusCode)
		}
	})
}
