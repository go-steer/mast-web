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
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The permission surface, and specifically v1.10.0's attribution
// (core-agent#830). Every case here is about the same distinction:
// a decision the daemon could attribute, and one it could not. The
// second is the one a client renders wrong, and it is only reachable
// against a mock that can be nobody.

func getApprovals(t *testing.T, srv *httptest.Server, who string) []map[string]any {
	t.Helper()
	resp := asCaller(t, http.MethodGet, srv.URL+"/sessions/smoke-session/perms", who, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET perms: want 200, got %d", resp.StatusCode)
	}
	var out struct {
		Mode      string           `json:"mode"`
		Approvals []map[string]any `json:"approvals"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Mode == "" {
		t.Fatalf("want a permission mode, got %v", out)
	}
	return out.Approvals
}

// The seed is a pair on purpose: a log where every row carried a name
// would let a renderer that assumes attribution pass its tests.
func TestMockPerms_SeededLogCarriesBothAttributionCases(t *testing.T) {
	srv := newMockServer(t)
	rows := getApprovals(t, srv, mockDefaultCaller)
	if len(rows) < 2 {
		t.Fatalf("want the two seeded approvals, got %v", rows)
	}
	if rows[0]["by"] != mockDefaultCaller {
		t.Fatalf("want the first row attributed to %s, got %v", mockDefaultCaller, rows[0])
	}
	if _, ok := rows[1]["by"]; ok {
		t.Fatalf("want `by` OMITTED on the unattributed row, not empty: %v", rows[1])
	}
}

func TestMockPerms_RespondAttributesTheVerifiedCaller(t *testing.T) {
	srv := newMockServer(t)
	resp := asCaller(t, http.MethodPost, srv.URL+"/sessions/smoke-session/perms/respond",
		mockOtherCaller, strings.NewReader(`{"id":"perms-1","decision":"allow-once"}`))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out["acknowledged"] != true {
		t.Fatalf("want acknowledged, got %v", out)
	}
	if out["approver"] != mockOtherCaller {
		t.Fatalf("want approver=%s, got %v", mockOtherCaller, out)
	}

	rows := getApprovals(t, srv, mockDefaultCaller)
	last := rows[len(rows)-1]
	if last["by"] != mockOtherCaller || last["decision"] != "allow-once" {
		t.Fatalf("want the new row attributed to the responder, got %v", last)
	}
}

// The case the field exists for. The decision lands, the log cannot
// name who made it, and both halves say so by omission rather than by
// an empty string a client could print.
func TestMockPerms_AnonymousResponderIsUnattributed(t *testing.T) {
	srv := newMockServer(t)
	resp := asCaller(t, http.MethodPost, srv.URL+"/sessions/smoke-session/perms/respond",
		"", strings.NewReader(`{"id":"perms-1","decision":"deny"}`))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out["acknowledged"] != true {
		t.Fatalf("want the decision to land regardless, got %v", out)
	}
	if _, ok := out["approver"]; ok {
		t.Fatalf("want `approver` omitted for an unverified caller, got %v", out)
	}

	rows := getApprovals(t, srv, mockDefaultCaller)
	last := rows[len(rows)-1]
	if _, ok := last["by"]; ok {
		t.Fatalf("want the new row unattributed, got %v", last)
	}
	if last["decision"] != "deny" {
		t.Fatalf("want the decision recorded anyway, got %v", last)
	}
}

// `approver` in the REQUEST is checked, never believed: it cannot
// widen what gets recorded, so the only thing it can do is disagree,
// and a client whose idea of who is approving differs from the
// server's wants to hear about it.
func TestMockPerms_RespondRejectsAMismatchedApprover(t *testing.T) {
	srv := newMockServer(t)
	resp := asCaller(t, http.MethodPost, srv.URL+"/sessions/smoke-session/perms/respond",
		mockDefaultCaller,
		strings.NewReader(`{"id":"perms-1","decision":"allow-once","approver":"`+mockOtherCaller+`"}`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 for an approver that isn't the caller, got %d", resp.StatusCode)
	}

	// And the matching one goes through, so the 400 is about the
	// disagreement rather than about the field being present.
	ok := asCaller(t, http.MethodPost, srv.URL+"/sessions/smoke-session/perms/respond",
		mockDefaultCaller,
		strings.NewReader(`{"id":"perms-1","decision":"allow-once","approver":"`+mockDefaultCaller+`"}`))
	if ok.StatusCode != http.StatusOK {
		t.Fatalf("want 200 when the approver agrees with the caller, got %d", ok.StatusCode)
	}
}

// The prompt stream carries prompts and nothing else. Without this the
// whole permission path is a channel the SPA opens that never speaks.
func TestMockPerms_RaisedPromptReachesTheStream(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Get(srv.URL + "/sessions/smoke-session/perms/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("want text/event-stream, got %q", ct)
	}

	// Subscribed as soon as the headers are out, so the raise below
	// cannot land before there is anyone to hear it.
	raise := asCaller(t, http.MethodPost, srv.URL+"/_mock/perms-prompt", mockDefaultCaller,
		strings.NewReader(`{"session":"smoke-session","tool":"bash_exec","detail":"rm -rf ./build"}`))
	if raise.StatusCode != http.StatusOK {
		t.Fatalf("raise: want 200, got %d", raise.StatusCode)
	}

	type framed struct{ event, data string }
	got := make(chan framed, 1)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		var ev string
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "event: ") {
				ev = strings.TrimPrefix(line, "event: ")
			}
			if strings.HasPrefix(line, "data: ") && ev != "" {
				got <- framed{ev, strings.TrimPrefix(line, "data: ")}
				return
			}
		}
	}()

	select {
	case fr := <-got:
		if fr.event != "prompt" {
			t.Fatalf("want a prompt frame, got %q", fr.event)
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(fr.data), &payload); err != nil {
			t.Fatal(err)
		}
		if payload["tool"] != "bash_exec" || payload["id"] == "" {
			t.Fatalf("want an identified bash_exec prompt, got %v", payload)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no prompt frame arrived on /perms/stream")
	}
}

// The answer names the tool the operator was looking at, not a
// placeholder — the correlation between a prompt and its decision is
// the only thing that makes the log readable.
func TestMockPerms_AnsweredPromptLogsItsTool(t *testing.T) {
	srv := newMockServer(t)
	raise := asCaller(t, http.MethodPost, srv.URL+"/_mock/perms-prompt", mockDefaultCaller,
		strings.NewReader(`{"session":"smoke-session","tool":"kube_apply"}`))
	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(raise.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.ID == "" {
		t.Fatal("want a prompt id back from the raise")
	}
	asCaller(t, http.MethodPost, srv.URL+"/sessions/smoke-session/perms/respond", mockDefaultCaller,
		strings.NewReader(`{"id":"`+out.ID+`","decision":"allow-session-tool"}`))

	rows := getApprovals(t, srv, mockDefaultCaller)
	last := rows[len(rows)-1]
	if last["tool"] != "kube_apply" {
		t.Fatalf("want the answered prompt's tool in the log, got %v", last)
	}
}

// The log is per-process state, so a spec can leak it into the next
// one — same problem the pause gates have, same escape hatch.
func TestMockPerms_ResetClearsTheLog(t *testing.T) {
	srv := newMockServer(t)
	asCaller(t, http.MethodPost, srv.URL+"/sessions/smoke-session/perms/respond", mockDefaultCaller,
		strings.NewReader(`{"id":"perms-1","decision":"allow-once"}`))
	if got := len(getApprovals(t, srv, mockDefaultCaller)); got != 3 {
		t.Fatalf("want the two seeded rows plus one, got %d", got)
	}

	resp := asCaller(t, http.MethodDelete, srv.URL+"/_mock/perms-log", mockDefaultCaller, nil)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reset: want 204, got %d", resp.StatusCode)
	}
	// The seeded pair survives: it is computed per read rather than
	// stored, because it is scenery rather than state.
	if got := len(getApprovals(t, srv, mockDefaultCaller)); got != 2 {
		t.Fatalf("want only the seeded rows after a reset, got %d", got)
	}
}
