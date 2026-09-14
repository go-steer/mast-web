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
	"sort"
	"strings"
	"testing"
)

// asCaller issues a request to the mock as a given identity. An empty
// `who` sends an empty cookie, which is how the mock spells anonymous.
func asCaller(t *testing.T, method, url, who string, body io.Reader) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: mockCallerCookie, Value: who})
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// sessionIDs reads a GET /sessions response into a sorted id list.
func sessionIDs(t *testing.T, resp *http.Response) []string {
	t.Helper()
	var out struct {
		Sessions []struct {
			SessionID string `json:"sessionID"`
		} `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(out.Sessions))
	for _, s := range out.Sessions {
		ids = append(ids, s.SessionID)
	}
	sort.Strings(ids)
	return ids
}

// The default caller is who every pre-existing smoke spec is, so this
// is also the regression guard for "the identity layer didn't change
// what the suite sees".
func TestMockACL_DefaultCallerSeesTheWholeFixtureRoster(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Get(srv.URL + "/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got := sessionIDs(t, resp)
	want := []string{"docs-writer", "ops-triage", "repo-indexer", "smoke-session"}
	if !slices.Equal(got, want) {
		t.Fatalf("default caller sees %v, want %v", got, want)
	}
}

// The one that matters: the second operator must NOT be handed the
// first operator's sessions. This is the leak the whole ACL design
// exists to prevent, and before the mock had two identities nothing in
// the repo could fail on it.
func TestMockACL_ListIsScopedToTheCaller(t *testing.T) {
	srv := newMockServer(t)

	got := sessionIDs(t, asCaller(t, http.MethodGet, srv.URL+"/sessions", mockOtherCaller, nil))
	// bob owns docs-writer and is a viewer on ops-triage. He must not
	// see smoke-session or repo-indexer at all.
	want := []string{"docs-writer", "ops-triage"}
	if !slices.Equal(got, want) {
		t.Fatalf("%s sees %v, want %v", mockOtherCaller, got, want)
	}

	// A caller nobody has shared anything with sees an empty list, not
	// an error — same as upstream's filter.
	if got := sessionIDs(t, asCaller(t, http.MethodGet, srv.URL+"/sessions", "carol@example.com", nil)); len(got) != 0 {
		t.Fatalf("a stranger sees %v, want nothing", got)
	}
	if got := sessionIDs(t, asCaller(t, http.MethodGet, srv.URL+"/sessions", "", nil)); len(got) != 0 {
		t.Fatalf("anonymous sees %v, want nothing", got)
	}
}

// Every row a caller can see must carry a `user` they can compare
// against /whoami — that equality is the entire basis for the browser
// telling "mine" from "shared with me", so a fixture that broke it
// would break the feature silently.
func TestMockACL_VisibleRowsCarryTheOwnerAsUser(t *testing.T) {
	for _, who := range []string{mockDefaultCaller, mockOtherCaller} {
		var mine, shared int
		for _, s := range visibleSessions(mockCaller{identity: who, source: "mock"}) {
			row := s.(map[string]any)
			sid := row["sessionID"].(string)
			if owner := mockSessionACLs[sid].owner; row["user"] != owner {
				t.Fatalf("%s: row %s has user %v but owner %s", who, sid, row["user"], owner)
			}
			if row["user"] == who {
				mine++
			} else {
				shared++
			}
		}
		// Both operators see one of each, so neither the "mine" nor the
		// "shared" branch can go unexercised whichever identity a spec
		// picks.
		if mine == 0 || shared == 0 {
			t.Fatalf("%s sees %d owned and %d shared, want at least one of each", who, mine, shared)
		}
	}
}

func TestMockACL_WhoamiEchoesTheCaller(t *testing.T) {
	srv := newMockServer(t)

	read := func(resp *http.Response) map[string]any {
		var got map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		return got
	}

	if got := read(asCaller(t, http.MethodGet, srv.URL+"/whoami", mockOtherCaller, nil)); got["identity"] != mockOtherCaller {
		t.Fatalf("cookie caller: identity = %v, want %s", got["identity"], mockOtherCaller)
	}
	if got := read(asCaller(t, http.MethodGet, srv.URL+"/whoami", "", nil)); got["identity"] != "" || got["source"] != "anonymous" {
		t.Fatalf("empty cookie: got %v, want anonymous", got)
	}

	// The header outranks the cookie, because that is the ordering a
	// real deployment relies on: the BFF asserts the caller and the
	// browser does not get a vote.
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/whoami", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: mockCallerCookie, Value: mockOtherCaller})
	req.Header.Set(assertedCallerHeader, "alice@example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got := read(resp)
	if got["identity"] != "alice@example.com" || got["source"] != "asserted" {
		t.Fatalf("header should outrank cookie, got %v", got)
	}
}

func TestMockACL_CreateStampsTheCallerAsOwner(t *testing.T) {
	srv := newMockServer(t)

	resp := asCaller(t, http.MethodPost, srv.URL+"/sessions", mockOtherCaller, strings.NewReader("{}"))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: status %d, want 201", resp.StatusCode)
	}
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["user"] != mockOtherCaller {
		t.Fatalf("created session user = %v, want %s", got["user"], mockOtherCaller)
	}

	// Anonymous cannot create — there are no unowned sessions.
	if r := asCaller(t, http.MethodPost, srv.URL+"/sessions", "", strings.NewReader("{}")); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous create: status %d, want 401", r.StatusCode)
	}

	// Creating on someone else's behalf is a 400 upstream rather than a
	// silently-ignored field, so it is a 400 here too.
	body := strings.NewReader(`{"owner":"` + mockDefaultCaller + `"}`)
	if r := asCaller(t, http.MethodPost, srv.URL+"/sessions", mockOtherCaller, body); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("create-on-behalf-of: status %d, want 400", r.StatusCode)
	}
}

func TestMockACL_OnlyTheOwnerMayDelete(t *testing.T) {
	srv := newMockServer(t)
	const path = "/sessions/core-agent/ops-triage"

	// bob is a viewer on ops-triage: he can read it, he cannot destroy
	// it. Read access is not admin access.
	if r := asCaller(t, http.MethodDelete, srv.URL+path, mockOtherCaller, nil); r.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer delete: status %d, want 403", r.StatusCode)
	}
	if r := asCaller(t, http.MethodDelete, srv.URL+path, mockDefaultCaller, nil); r.StatusCode != http.StatusNoContent {
		t.Fatalf("owner delete: status %d, want 204", r.StatusCode)
	}
}
