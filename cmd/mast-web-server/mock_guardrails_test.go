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
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
)

// Guardrail trips (1.13.0), durable failure rows (1.19.0), and the
// permission answers 1.14.0–1.18.0 changed. The mock has to produce each
// of these exactly as a daemon does before v0.6's browser work can be
// tested against it — see mock_guardrails.go and docs/v0.6-plan.md §7.

// collect reads frames until quiet for `idle`, skipping the attach-time
// replay the caller has already waited out. For asserting ORDER, which
// awaitFrame (first match, skip the rest) cannot.
func collect(t *testing.T, frames <-chan sseFrame, idle time.Duration) []sseFrame {
	t.Helper()
	var out []sseFrame
	for {
		select {
		case fr, ok := <-frames:
			if !ok {
				return out
			}
			out = append(out, fr)
		case <-time.After(idle):
			return out
		}
	}
}

// rowOf unpacks an `agent` frame carrying an eventlog row.
func rowOf(fr sseFrame) (id, author, invocation string, meta map[string]any) {
	ev, _ := fr.Data["event"].(map[string]any)
	id, _ = ev["ID"].(string)
	author, _ = ev["Author"].(string)
	invocation, _ = ev["InvocationID"].(string)
	meta, _ = ev["CustomMetadata"].(map[string]any)
	return
}

// A trip at a turn boundary: the frame says halted_turn:false (present,
// not omitted), no cancel follows, and the session is halted — which
// GET /guardrails, not the frame, is the authority on.
func TestMockGuardrails_BoundaryTripHaltsTheSession(t *testing.T) {
	srv := newMockServer(t)
	frames, closeStream := attached(t, srv, "smoke-session")
	defer closeStream()

	out := postJSON(t, srv, "/_mock/guardrail-trip",
		`{"session":"smoke-session","guardrail":"watchdog","halted_turn":false}`)
	tripID, _ := out["event_id"].(string)
	if tripID == "" || out["halted"] != true {
		t.Fatalf("want an event_id and halted:true back, got %#v", out)
	}

	got := collect(t, frames, 200*time.Millisecond)
	if len(got) != 2 || got[0].Event != "guardrail-trip" || got[1].Event != "agent" {
		t.Fatalf("want guardrail-trip then its row, got %v", eventNames(got))
	}
	if v, present := got[0].Data["halted_turn"]; !present || v != false {
		t.Fatalf("halted_turn must be present and false, got %#v (present=%v)", v, present)
	}
	if got[0].Data["event_id"] != tripID {
		t.Fatalf("frame event_id %v, want %s", got[0].Data["event_id"], tripID)
	}
	if !strings.Contains(got[0].Data["reason"].(string), "/guardrail reset watchdog") {
		t.Fatalf("want the producer's reason, naming the reset, got %q", got[0].Data["reason"])
	}
	id, author, invocation, meta := rowOf(got[1])
	if id != tripID || author != "agent/guardrail-trip" || invocation != "guardrail-trip" {
		t.Fatalf("want the halt row paired by id, got id=%s author=%s inv=%s", id, author, invocation)
	}
	if meta["halted_turn"] != false || meta["guardrail"] != "watchdog" {
		t.Fatalf("row metadata: %#v", meta)
	}

	g := getJSON(t, srv, "/sessions/smoke-session/guardrails")
	wd, _ := g["watchdog"].(map[string]any)
	if g["halted"] != true || wd["tripped"] != true {
		t.Fatalf("GET /guardrails should say halted with the watchdog tripped, got %#v", g)
	}
}

// A trip mid-turn, in the order a daemon sends it: the trip, the cut
// turn's turn-error row and then its typed canceled (row first for a
// turn error), then the trip's own row. The canceled carries the row's
// id as event_id and names the guardrail as cut_by.
func TestMockGuardrails_MidTurnTripCutsTheTurnInOrder(t *testing.T) {
	srv := newPlayingMockServer(t, 200) // slow enough to trip mid-turn
	frames, closeStream := attached(t, srv, "smoke-session")
	defer closeStream()

	postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)
	awaitFrame(t, frames, "wake")
	out := postJSON(t, srv, "/_mock/guardrail-trip", `{"session":"smoke-session"}`)
	tripID, _ := out["event_id"].(string)

	got := collect(t, frames, 700*time.Millisecond)
	// Frames the turn put out BEFORE the trip are allowed — on a slow
	// runner the playback's first frame can beat the POST — so the
	// order is checked from the trip on. What must hold is that the cut
	// comes after the trip and nothing of the turn comes after the cut.
	start := slices.Index(eventNames(got), "guardrail-trip")
	if start < 0 {
		t.Fatalf("no guardrail-trip frame: %v", eventNames(got))
	}
	got = got[start:]
	want := []string{"guardrail-trip", "agent", "turn-error", "agent"}
	if strings.Join(eventNames(got), ",") != strings.Join(want, ",") {
		t.Fatalf("from the trip on, want %v, got %v", want, eventNames(got))
	}
	if got[0].Data["halted_turn"] != true {
		t.Fatalf("a trip with a turn in flight cut it: want halted_turn:true, got %#v", got[0].Data)
	}
	errRowID, errAuthor, _, errMeta := rowOf(got[1])
	if errAuthor != "agent/turn-error" || errMeta["cut_by"] != "cost_ceiling" {
		t.Fatalf("want the turn-error row with cut_by, got author=%s meta=%#v", errAuthor, errMeta)
	}
	if got[2].Data["kind"] != "canceled" || got[2].Data["event_id"] != errRowID {
		t.Fatalf("want canceled paired to its row, got %#v (row %s)", got[2].Data, errRowID)
	}
	if id, author, _, _ := rowOf(got[3]); id != tripID || author != "agent/guardrail-trip" {
		t.Fatalf("want the trip's row last, got id=%s author=%s", id, author)
	}
	if _, _, inFlight := statusOf(t, srv, "smoke-session"); inFlight {
		t.Fatal("the cut turn is still in flight")
	}
}

// core-agent#1049: a per-turn cost trip ends one turn and leaves the
// session running. Its row is the turn-trip row, which can never
// restore as a halt, and GET /guardrails says not halted.
func TestMockGuardrails_PerTurnTripDoesNotHalt(t *testing.T) {
	srv := newMockServer(t)
	frames, closeStream := attached(t, srv, "smoke-session")
	defer closeStream()

	out := postJSON(t, srv, "/_mock/guardrail-trip",
		`{"session":"smoke-session","halts_session":false,"halted_turn":false}`)
	if out["halted"] != false {
		t.Fatalf("a per-turn trip must not halt, got %#v", out)
	}
	got := collect(t, frames, 200*time.Millisecond)
	if len(got) != 2 {
		t.Fatalf("want the trip and its row, got %v", eventNames(got))
	}
	if !strings.Contains(got[0].Data["reason"].(string), "NOT halted") {
		t.Fatalf("want the per-turn wording, got %q", got[0].Data["reason"])
	}
	if _, author, invocation, _ := rowOf(got[1]); author != "agent/guardrail-turn-trip" || invocation != "guardrail-turn-trip" {
		t.Fatalf("want the turn-trip row, got %s / %s", author, invocation)
	}
	if g := getJSON(t, srv, "/sessions/smoke-session/guardrails"); g["halted"] != false {
		t.Fatalf("GET /guardrails says halted after a per-turn trip: %#v", g)
	}
}

// The dead end, from the server's side: an inject into a halted session
// is accepted and queued, and nothing follows on the stream. No wake, no
// turn, no frame a client waiting for a turn to end could ever receive
// (core-agent#1040). v0.6 PR 1 (#111) fixes the browser against this.
func TestMockGuardrails_InjectIntoAHaltedSessionRunsNothing(t *testing.T) {
	srv := newPlayingMockServer(t, 0)
	frames, closeStream := attached(t, srv, "smoke-session")
	defer closeStream()

	postJSON(t, srv, "/_mock/guardrail-trip", `{"session":"smoke-session","halted_turn":false}`)
	collect(t, frames, 150*time.Millisecond) // the trip and its row

	out := postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"are you there?"}`)
	if out["prompt_id"] == nil || out["injected"] != "are you there?" {
		t.Fatalf("the inject is accepted and queued: want a 200 with prompt_id, got %#v", out)
	}
	if got := collect(t, frames, 300*time.Millisecond); len(got) != 0 {
		t.Fatalf("a halted session ran something: %v", eventNames(got))
	}
	if _, _, inFlight := statusOf(t, srv, "smoke-session"); inFlight {
		t.Fatal("a halted session reports a turn in flight")
	}
}

// And the way out: the reset clears the halt and the queued message runs
// as the first turn after it.
func TestMockGuardrails_ResetDrainsWhatWasQueued(t *testing.T) {
	srv := newPlayingMockServer(t, 0)
	frames, closeStream := attached(t, srv, "smoke-session")
	defer closeStream()

	postJSON(t, srv, "/_mock/guardrail-trip", `{"session":"smoke-session","halted_turn":false}`)
	postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"are you there?"}`)
	collect(t, frames, 150*time.Millisecond)

	out := postJSON(t, srv, "/sessions/smoke-session/guardrails/reset", `{}`)
	g, _ := out["guardrails"].(map[string]any)
	if g["halted"] != false {
		t.Fatalf("reset should clear the halt, got %#v", out)
	}
	awaitFrame(t, frames, "wake")
	awaitFrame(t, frames, "turn-complete")
}

func TestMockGuardrails_ResetEndpointClearsEverything(t *testing.T) {
	srv := newMockServer(t)
	postJSON(t, srv, "/_mock/guardrail-trip", `{"session":"smoke-session","halted_turn":false}`)
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/_mock/guardrails", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("want 204, got %d", resp.StatusCode)
	}
	if g := getJSON(t, srv, "/sessions/smoke-session/guardrails"); g["halted"] != false {
		t.Fatalf("still halted after the reset endpoint: %#v", g)
	}
}

// 1.19.0 for an ordinary STOP: the cancel is durable too, row first,
// paired by event_id.
func TestMockGuardrails_StopsCancelIsDurable(t *testing.T) {
	srv := newMockServer(t)
	frames, closeStream := attached(t, srv, "smoke-session")
	defer closeStream()

	postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)
	awaitFrame(t, frames, "wake")
	postJSON(t, srv, "/sessions/smoke-session/interrupt", `{"hold":false}`)

	got := collect(t, frames, 200*time.Millisecond)
	if strings.Join(eventNames(got), ",") != "agent,turn-error" {
		t.Fatalf("want the turn-error row then its frame, got %v", eventNames(got))
	}
	id, author, _, meta := rowOf(got[0])
	if author != "agent/turn-error" || meta["cut_by"] != nil {
		t.Fatalf("an operator's STOP is not a guardrail's cut: author=%s meta=%#v", author, meta)
	}
	if got[1].Data["event_id"] != id {
		t.Fatalf("frame event_id %v, row id %s", got[1].Data["event_id"], id)
	}
}

func eventNames(frames []sseFrame) []string {
	out := make([]string, 0, len(frames))
	for _, f := range frames {
		out = append(out, f.Event)
	}
	return out
}

// ─── Permission answers, 1.14.0–1.18.0 ───────────────────────────────

func respond(t *testing.T, srvURL, caller, body string) (int, map[string]any, string) {
	t.Helper()
	resp := asCaller(t, http.MethodPost, srvURL+"/sessions/smoke-session/perms/respond", caller,
		strings.NewReader(body))
	defer resp.Body.Close()
	buf := new(strings.Builder)
	_, _ = io.Copy(buf, resp.Body)
	var out map[string]any
	_ = json.Unmarshal([]byte(buf.String()), &out)
	return resp.StatusCode, out, buf.String()
}

// 1.14.0: a prompt that was there and is gone is a 410, and the two
// bodies are different facts. An id already answered is a 404.
func TestMockPerms_GonePromptsAre410AndSayWhich(t *testing.T) {
	srv := newMockServer(t)
	for _, tc := range []struct{ why, want string }{
		{"expired", promptExpiredBody},
		{"canceled", promptCanceledBody},
	} {
		id := raiseOne(t, srv)
		postJSON(t, srv, "/_mock/perms-prompt-end", `{"id":"`+id+`","why":"`+tc.why+`"}`)
		code, _, body := respond(t, srv.URL, mockDefaultCaller, `{"id":"`+id+`","decision":"allow-once"}`)
		if code != http.StatusGone || !strings.Contains(body, tc.want) {
			t.Fatalf("%s: want 410 %q, got %d %q", tc.why, tc.want, code, body)
		}
	}

	id := raiseOne(t, srv)
	if code, _, _ := respond(t, srv.URL, mockDefaultCaller, `{"id":"`+id+`","decision":"allow-once"}`); code != http.StatusOK {
		t.Fatalf("first answer: want 200, got %d", code)
	}
	if code, _, _ := respond(t, srv.URL, mockDefaultCaller, `{"id":"`+id+`","decision":"deny"}`); code != http.StatusNotFound {
		t.Fatalf("second answer to one prompt: want 404, got %d", code)
	}
}

// A STOP cuts the turn, and the prompt its turn was waiting on goes
// with it: an answer after that is the second 410.
func TestMockPerms_ACutTurnCancelsItsPrompts(t *testing.T) {
	srv := newMockServer(t)
	postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)
	id := raiseOne(t, srv)
	postJSON(t, srv, "/sessions/smoke-session/interrupt", `{"hold":false}`)
	code, _, body := respond(t, srv.URL, mockDefaultCaller, `{"id":"`+id+`","decision":"allow-once"}`)
	if code != http.StatusGone || !strings.Contains(body, "turn ended before the approval arrived") {
		t.Fatalf("want 410 canceled after a STOP, got %d %q", code, body)
	}
}

// 1.17.0 / 1.18.0: what's applied, which is not always what was sent.
func TestMockPerms_RespondReportsWhatWasApplied(t *testing.T) {
	srv := newMockServer(t)

	// An escalated prompt: any allow is applied once.
	raise := asCaller(t, http.MethodPost, srv.URL+"/_mock/perms-prompt", mockDefaultCaller,
		strings.NewReader(`{"session":"smoke-session","tool":"bash_exec","detail":"kubectl rollout restart deploy/api",`+
			`"approver_model":"claude-sonnet-5-5","approver_reason":"restarts production; the task did not ask for it"}`))
	var raised struct{ ID string }
	_ = json.NewDecoder(raise.Body).Decode(&raised)
	code, out, _ := respond(t, srv.URL, mockDefaultCaller, `{"id":"`+raised.ID+`","decision":"allow-session-tool"}`)
	if code != http.StatusOK || out["decision"] != "allow-once" || out["downgraded"] != true {
		t.Fatalf("escalated allow: want allow-once downgraded, got %d %#v", code, out)
	}

	// allow-always from a non-admin: applied for the session.
	id := raiseOne(t, srv)
	_, out, _ = respond(t, srv.URL, mockDefaultCaller, `{"id":"`+id+`","decision":"allow-always"}`)
	if out["decision"] != "allow-session" || out["downgraded"] != true {
		t.Fatalf("allow-always: want allow-session downgraded, got %#v", out)
	}

	// Anything else: applied as sent, and downgraded omitted, not false.
	id = raiseOne(t, srv)
	_, out, _ = respond(t, srv.URL, mockDefaultCaller, `{"id":"`+id+`","decision":"allow-once"}`)
	if out["decision"] != "allow-once" {
		t.Fatalf("want the decision echoed, got %#v", out)
	}
	if _, present := out["downgraded"]; present {
		t.Fatalf("downgraded must be omitted when false, got %#v", out)
	}

	// The log records what was applied, not what was asked for.
	rows := getApprovals(t, srv, mockDefaultCaller)
	if rows[2]["decision"] != "allow-once" || rows[2]["key"] != "kubectl rollout restart deploy/api" {
		t.Fatalf("the escalated row should log the applied decision: %#v", rows[2])
	}
}

// 1.15.0: a reason is deny-only and capped, and a refused request leaves
// the prompt pending so it can be sent again.
func TestMockPerms_DenyReasonRules(t *testing.T) {
	srv := newMockServer(t)
	id := raiseOne(t, srv)

	if code, _, _ := respond(t, srv.URL, mockDefaultCaller,
		`{"id":"`+id+`","decision":"allow-once","reason":"only this once"}`); code != http.StatusBadRequest {
		t.Fatalf("a reason on an allow: want 400, got %d", code)
	}
	long := strings.Repeat("x", maxDenyReasonBytes+1)
	if code, _, _ := respond(t, srv.URL, mockDefaultCaller,
		`{"id":"`+id+`","decision":"deny","reason":"`+long+`"}`); code != http.StatusBadRequest {
		t.Fatalf("an over-long reason: want 400, got %d", code)
	}
	// Still pending after both refusals, and whitespace collapses
	// before the length is checked.
	padded := "restart   the\\n canary first"
	if code, _, _ := respond(t, srv.URL, mockDefaultCaller,
		`{"id":"`+id+`","decision":"deny","reason":"`+padded+`"}`); code != http.StatusOK {
		t.Fatalf("a valid deny with a reason after two refusals: want 200, got %d", code)
	}
}

// 1.16.0 / 1.18.0: the mode, who may set it, and what it may be set to.
func TestMockPerms_ModeIsOwnerOnlyAndSettable(t *testing.T) {
	srv := newMockServer(t)
	perms := getJSON(t, srv, "/sessions/smoke-session/perms")
	if perms["mode"] != "ask" {
		t.Fatalf("want the configured mode first, got %#v", perms["mode"])
	}
	modes, _ := perms["settable_modes"].([]any)
	if len(modes) == 0 || modes[0] != "ask" {
		t.Fatalf("want settable_modes in the chip's order, got %#v", perms["settable_modes"])
	}

	out := postJSON(t, srv, "/sessions/smoke-session/perms/mode", `{"mode":"plan"}`)
	if out["previous"] != "ask" || out["mode"] != "plan" {
		t.Fatalf("want {previous: ask, mode: plan}, got %#v", out)
	}
	if got := getJSON(t, srv, "/sessions/smoke-session/perms")["mode"]; got != "plan" {
		t.Fatalf("GET /perms should report the new mode, got %v", got)
	}

	// bob can read ops-triage but doesn't own it: the refusal is the
	// same 404 as a session that doesn't exist.
	resp := asCaller(t, http.MethodPost, srv.URL+"/sessions/ops-triage/perms/mode", mockOtherCaller,
		strings.NewReader(`{"mode":"yolo"}`))
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("a non-owner: want 404, got %d", resp.StatusCode)
	}

	// `allow` is config-only, never settable over HTTP.
	resp = asCaller(t, http.MethodPost, srv.URL+"/sessions/smoke-session/perms/mode", mockDefaultCaller,
		strings.NewReader(`{"mode":"allow"}`))
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("mode allow: want 400, got %d", resp.StatusCode)
	}
}
