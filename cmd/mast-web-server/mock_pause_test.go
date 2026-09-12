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
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The mock's pause gate (protocol v1.5.0). These tests are the reason
// the gate is stateful at all: #68 — a Stop button that parked the
// session instead of cancelling the turn — was unreproducible against
// the old mock, which answered every /interrupt identically and never
// held anything.

// ─── Helpers ─────────────────────────────────────────────────────────

func postJSON(t *testing.T, srv *httptest.Server, path, body string) map[string]any {
	t.Helper()
	resp, err := http.Post(srv.URL+path, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST %s: want 200, got %d (%s)", path, resp.StatusCode, raw)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("POST %s: decode: %v", path, err)
	}
	return out
}

func getJSON(t *testing.T, srv *httptest.Server, path string) map[string]any {
	t.Helper()
	resp, err := http.Get(srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("GET %s: decode: %v", path, err)
	}
	return out
}

// sseFrame is one decoded `event:`/`data:` pair off a live stream.
type sseFrame struct {
	Event string
	Data  map[string]any
}

// openStream attaches to a session's SSE endpoint and returns a channel
// of decoded frames plus a closer. Used to assert that a POST made
// afterwards actually reaches an already-open stream — the thing a
// fixture-replay-only mock can never show.
func openStream(t *testing.T, srv *httptest.Server, sid string) (<-chan sseFrame, func()) {
	t.Helper()
	resp, err := http.Get(srv.URL + "/sessions/" + sid + "/events")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("open stream: want 200, got %d", resp.StatusCode)
	}

	out := make(chan sseFrame, 32)
	go func() {
		defer close(out)
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		var event string
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				var data map[string]any
				_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &data)
				out <- sseFrame{Event: event, Data: data}
				event = ""
			}
		}
	}()
	return out, func() { resp.Body.Close() }
}

// awaitFrame waits for the next frame with the given event name,
// skipping anything else on the stream (the fixture replay arrives
// first). Fails the test rather than hanging forever.
func awaitFrame(t *testing.T, frames <-chan sseFrame, event string) sseFrame {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case fr, ok := <-frames:
			if !ok {
				t.Fatalf("stream closed before a %q frame arrived", event)
			}
			if fr.Event == event {
				return fr
			}
		case <-deadline:
			t.Fatalf("timed out waiting for a %q frame", event)
		}
	}
}

// ─── /interrupt ──────────────────────────────────────────────────────

// The v1.5.0 default flip, from the mock's side. An /interrupt with no
// body parks the session — which is precisely the behaviour that made
// our Stop button wedge sessions in #68, and which no test could
// observe before this.
func TestMock_Interrupt_EmptyBodyHolds(t *testing.T) {
	srv := newMockServer(t)
	got := postJSON(t, srv, "/sessions/smoke-session/interrupt", "{}")
	if got["paused"] != true {
		t.Fatalf("want paused:true for an omitted hold flag (v1.5.0 default), got %#v", got["paused"])
	}
	if st := getJSON(t, srv, "/sessions/smoke-session/status"); st["paused"] != true {
		t.Fatalf("want the gate visible on /status, got %#v", st["paused"])
	}
}

// The fix in #68: an explicit hold:false is the pre-v1.5.0
// cancel-and-carry-on, and the spec requires producers to honour it.
func TestMock_Interrupt_ExplicitHoldFalseDoesNotPark(t *testing.T) {
	srv := newMockServer(t)
	got := postJSON(t, srv, "/sessions/smoke-session/interrupt", `{"hold": false}`)
	if got["paused"] != false {
		t.Fatalf("want paused:false for an explicit hold:false, got %#v", got["paused"])
	}
	if st := getJSON(t, srv, "/sessions/smoke-session/status"); st["paused"] != false {
		t.Fatalf("want an open gate on /status, got %#v", st["paused"])
	}
}

// Pre-v1.5.0 consumers read the header and never look at the body, so
// it has to keep telling them the truth.
func TestMock_Interrupt_KeepsLegacyHeader(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Post(srv.URL+"/sessions/smoke-session/interrupt", "application/json", strings.NewReader(`{"hold": false}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("X-Interrupted"); got != "nothing-in-flight" {
		t.Fatalf("want X-Interrupted: nothing-in-flight, got %q", got)
	}
}

// ─── /pause + /resume ────────────────────────────────────────────────

func TestMock_Pause_IsIdempotent(t *testing.T) {
	srv := newMockServer(t)
	first := postJSON(t, srv, "/sessions/smoke-session/pause", `{"reason": "reading the diff"}`)
	if first["paused"] != true || first["transitioned"] != true {
		t.Fatalf("want paused+transitioned on the first press, got %#v", first)
	}
	if first["pause_reason"] != "reading the diff" {
		t.Fatalf("want the caller's reason echoed, got %#v", first["pause_reason"])
	}

	second := postJSON(t, srv, "/sessions/smoke-session/pause", "{}")
	if second["paused"] != true {
		t.Fatalf("want the gate still closed, got %#v", second["paused"])
	}
	// The point of `transitioned`: a second operator surface racing the
	// same click stays quiet instead of reporting a redundant success.
	if second["transitioned"] != false {
		t.Fatalf("want transitioned:false on a redundant press, got %#v", second["transitioned"])
	}
	// And it must not restamp the clock — "paused for 4m" jumping back
	// to zero because someone pressed again is a lie to the operator.
	if second["paused_since"] != first["paused_since"] {
		t.Fatalf("want paused_since preserved, got %v then %v", first["paused_since"], second["paused_since"])
	}
	if second["pause_reason"] != "reading the diff" {
		t.Fatalf("want the original reason preserved, got %#v", second["pause_reason"])
	}
}

func TestMock_Resume_OpensTheGate(t *testing.T) {
	srv := newMockServer(t)
	postJSON(t, srv, "/sessions/smoke-session/pause", "{}")

	got := postJSON(t, srv, "/sessions/smoke-session/resume", `{"steer": "try the other branch"}`)
	if got["resumed"] != true {
		t.Fatalf("want resumed:true, got %#v", got["resumed"])
	}
	// Mode defaults off the payload: steer text present means steer.
	if got["mode"] != resumeModeSteer {
		t.Fatalf("want mode %q inferred from steer text, got %#v", resumeModeSteer, got["mode"])
	}
	if st := getJSON(t, srv, "/sessions/smoke-session/status"); st["paused"] != false {
		t.Fatalf("want an open gate on /status, got %#v", st["paused"])
	}
}

func TestMock_Resume_DefaultsToContinueWithoutSteer(t *testing.T) {
	srv := newMockServer(t)
	postJSON(t, srv, "/sessions/smoke-session/pause", "{}")
	got := postJSON(t, srv, "/sessions/smoke-session/resume", "{}")
	if got["mode"] != resumeModeContinue {
		t.Fatalf("want mode %q for an empty body, got %#v", resumeModeContinue, got["mode"])
	}
}

// Resuming an open gate is a 200 with resumed:false, not an error —
// same idempotency contract /pause has, for the same reason.
func TestMock_Resume_UnpausedIsNotAnError(t *testing.T) {
	srv := newMockServer(t)
	got := postJSON(t, srv, "/sessions/smoke-session/resume", "{}")
	if got["resumed"] != false {
		t.Fatalf("want resumed:false against an open gate, got %#v", got["resumed"])
	}
}

// ─── Events on the live stream ───────────────────────────────────────

// The gate is only useful to a consumer if it can see the transition.
// This is the whole reason the mock grew a fan-out: a client that only
// ever sees fixture replay can never be tested against a pause it
// caused itself.
func TestMock_PauseEventReachesAnOpenStream(t *testing.T) {
	srv := newMockServer(t)
	frames, closeStream := openStream(t, srv, "smoke-session")
	defer closeStream()

	postJSON(t, srv, "/sessions/smoke-session/pause", `{"reason": "operator paused"}`)

	fr := awaitFrame(t, frames, "pause")
	if fr.Data["state"] != pauseStatePaused {
		t.Fatalf("want state %q, got %#v", pauseStatePaused, fr.Data["state"])
	}
	if fr.Data["reason"] != "operator paused" {
		t.Fatalf("want the reason carried on the event, got %#v", fr.Data["reason"])
	}
	if _, ok := fr.Data["at"].(string); !ok {
		t.Fatalf("want an `at` timestamp, got %#v", fr.Data["at"])
	}
}

func TestMock_ResumeEventCarriesTheMode(t *testing.T) {
	srv := newMockServer(t)
	frames, closeStream := openStream(t, srv, "smoke-session")
	defer closeStream()

	postJSON(t, srv, "/sessions/smoke-session/pause", "{}")
	awaitFrame(t, frames, "pause")
	postJSON(t, srv, "/sessions/smoke-session/resume", `{"mode": "abandon"}`)

	fr := awaitFrame(t, frames, "pause")
	if fr.Data["state"] != pauseStateResumed {
		t.Fatalf("want state %q, got %#v", pauseStateResumed, fr.Data["state"])
	}
	// A second client watching the stream renders what the operator
	// chose, not merely that something happened.
	if fr.Data["mode"] != resumeModeAbandon {
		t.Fatalf("want mode %q echoed, got %#v", resumeModeAbandon, fr.Data["mode"])
	}
}

// v1.7.0's wake. An /inject wakes the loop, and the agent says so.
func TestMock_InjectEmitsWake(t *testing.T) {
	srv := newMockServer(t)
	frames, closeStream := openStream(t, srv, "smoke-session")
	defer closeStream()

	postJSON(t, srv, "/sessions/smoke-session/inject", `{"text": "hello"}`)

	fr := awaitFrame(t, frames, "wake")
	// The payload is deliberately just a timestamp: a wake says "look
	// now" and the thing that woke the loop reports itself separately.
	if _, ok := fr.Data["at"].(string); !ok {
		t.Fatalf("want an `at` timestamp, got %#v", fr.Data["at"])
	}
	if len(fr.Data) != 1 {
		t.Fatalf("want `at` alone on a wake payload, got %#v", fr.Data)
	}
}

// A pause on one session must not show up on another's stream. Sessions
// are the broadcast granularity; leaking across them would have every
// spatial.html panel react to every other panel's operator.
func TestMock_PauseEventIsScopedToItsSession(t *testing.T) {
	srv := newMockServer(t)
	frames, closeStream := openStream(t, srv, "ops-triage")
	defer closeStream()

	postJSON(t, srv, "/sessions/smoke-session/pause", "{}")
	// The inject's wake is the marker. Both publishes are ordered
	// before it on the server, so by the time the wake lands a leaked
	// pause would already have landed too — reading until the marker
	// and failing on a pause along the way is a real check, not a race.
	postJSON(t, srv, "/sessions/ops-triage/inject", `{"text": "marker"}`)

	deadline := time.After(3 * time.Second)
	for {
		select {
		case fr, ok := <-frames:
			if !ok {
				t.Fatal("stream closed before the marker wake arrived")
			}
			if fr.Event == "pause" {
				t.Fatal("smoke-session's pause leaked onto ops-triage's stream")
			}
			if fr.Event == "wake" {
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for the marker wake")
		}
	}
}

// ─── Test-only reset ─────────────────────────────────────────────────

func TestMock_ResetPauseGates(t *testing.T) {
	srv := newMockServer(t)
	postJSON(t, srv, "/sessions/smoke-session/pause", "{}")

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/_mock/pause-gates", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("want 204, got %d", resp.StatusCode)
	}

	if st := getJSON(t, srv, "/sessions/smoke-session/status"); st["paused"] != false {
		t.Fatalf("want the gate cleared, got %#v", st["paused"])
	}
}
