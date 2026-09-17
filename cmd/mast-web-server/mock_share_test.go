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
	"net/http/httptest"
	"strings"
	"testing"
)

// The v1.10.0 sharing and naming endpoints — GET/PATCH
// /sessions/{sid}/acl (core-agent#797) and POST /sessions/{sid}/title
// (#808).
//
// What these tests are for is the handful of contract details a client
// gets wrong by guessing: that a denial is 404 and not 403, that an
// omitted PATCH list is not an empty one, that viewers and
// contributors are different grants, and that `persisted: false` is
// not a failure.

// patchAs sends a PATCH as a given caller and returns the response.
func patchAs(t *testing.T, srv *httptest.Server, path, who, body string) *http.Response {
	t.Helper()
	return asCaller(t, http.MethodPatch, srv.URL+path, who, strings.NewReader(body))
}

// decodeACL reads an ACL body, insisting the lists are present. That
// insistence is the test: upstream never omits them, and a client that
// had to tell a missing key from an empty list would be guessing about
// the one endpoint whose whole job is reporting who is on the list.
func decodeACL(t *testing.T, resp *http.Response) (string, []string, []string) {
	t.Helper()
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		t.Fatalf("decode acl: %v", err)
	}
	for _, key := range []string{"owner", "viewers", "contributors"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("acl body omits %q: %v", key, raw)
		}
	}
	var owner string
	var viewers, contributors []string
	if err := json.Unmarshal(raw["owner"], &owner); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw["viewers"], &viewers); err != nil {
		t.Fatalf("viewers is not a list (null, maybe?): %v", err)
	}
	if err := json.Unmarshal(raw["contributors"], &contributors); err != nil {
		t.Fatalf("contributors is not a list (null, maybe?): %v", err)
	}
	return owner, viewers, contributors
}

func TestMockACL_OwnerReadsTheirOwnACL(t *testing.T) {
	srv := newMockServer(t)

	resp := asCaller(t, http.MethodGet, srv.URL+"/sessions/ops-triage/acl", mockDefaultCaller, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("owner reading their own ACL: want 200, got %d", resp.StatusCode)
	}
	owner, viewers, contributors := decodeACL(t, resp)
	if owner != mockDefaultCaller {
		t.Errorf("owner = %q, want %q", owner, mockDefaultCaller)
	}
	if len(viewers) != 1 || viewers[0] != mockOtherCaller {
		t.Errorf("viewers = %v, want [%s]", viewers, mockOtherCaller)
	}
	// Empty, not absent, and not null. A seeded row with no
	// contributors still has to say so out loud.
	if len(contributors) != 0 {
		t.Errorf("contributors = %v, want []", contributors)
	}
}

// Both verbs are ActionSessionAdmin, so a viewer cannot read the ACL
// of a session shared with them. The read is gated as hard as the
// write on purpose: the list names the other people who can see an
// incident.
//
// And the denial is 404, not 403 — upstream makes an unauthorized
// session indistinguishable from a missing one so the API can't be
// probed for other people's sessions. That is also why the SPA cannot
// feature-detect this route by trying it, and has to read the
// negotiated protocol version instead.
func TestMockACL_DenialIs404NotForbidden(t *testing.T) {
	srv := newMockServer(t)

	for _, tc := range []struct {
		name, who, sid string
	}{
		// bob is a VIEWER on ops-triage, which is read on the session
		// and nothing on its ACL.
		{"viewer of a shared session", mockOtherCaller, "ops-triage"},
		{"a stranger", "carol@example.com", "ops-triage"},
		{"anonymous", "", "ops-triage"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := asCaller(t, http.MethodGet, srv.URL+"/sessions/"+tc.sid+"/acl", tc.who, nil)
			if resp.StatusCode != http.StatusNotFound {
				t.Errorf("GET acl: want 404, got %d — a 403 here would let a caller "+
					"tell 'not yours' from 'no such session'", resp.StatusCode)
			}
			resp = patchAs(t, srv, "/sessions/"+tc.sid+"/acl", tc.who, `{"viewers":["mallory"]}`)
			if resp.StatusCode != http.StatusNotFound {
				t.Errorf("PATCH acl: want 404, got %d", resp.StatusCode)
			}
		})
	}
}

// The reason this endpoint is a PATCH. An omitted list is left alone
// and `[]` clears it; collapsing the two would mean a caller adding a
// contributor silently wiped the viewers somebody set last week.
func TestMockACL_PatchOmittedListIsNotAnEmptyOne(t *testing.T) {
	srv := newMockServer(t)
	const path = "/sessions/ops-triage/acl"

	resp := patchAs(t, srv, path, mockDefaultCaller, `{"contributors":["responder@example.com"]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH: want 200, got %d", resp.StatusCode)
	}
	_, viewers, contributors := decodeACL(t, resp)
	if len(viewers) != 1 || viewers[0] != mockOtherCaller {
		t.Fatalf("viewers = %v after a contributors-only PATCH, want them untouched", viewers)
	}
	if len(contributors) != 1 || contributors[0] != "responder@example.com" {
		t.Fatalf("contributors = %v, want the one we sent", contributors)
	}

	// Now the other half: an explicit empty list DOES clear.
	resp = patchAs(t, srv, path, mockDefaultCaller, `{"viewers":[]}`)
	_, viewers, contributors = decodeACL(t, resp)
	if len(viewers) != 0 {
		t.Fatalf("viewers = %v after an explicit [], want cleared", viewers)
	}
	if len(contributors) != 1 {
		t.Fatalf("contributors = %v, want the earlier edit preserved", contributors)
	}
}

// Viewers and contributors are different grants and must not be
// collapsed into one "shared with" list. Contributors is the
// escalation case the endpoint was filed for.
func TestMockACL_ContributorsAreADistinctGrant(t *testing.T) {
	srv := newMockServer(t)

	// smoke-session starts private. Grant bob CONTRIBUTOR, not viewer.
	resp := patchAs(t, srv, "/sessions/smoke-session/acl", mockDefaultCaller,
		`{"contributors":["`+mockOtherCaller+`"]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH: want 200, got %d", resp.StatusCode)
	}
	_, viewers, contributors := decodeACL(t, resp)
	if len(viewers) != 0 {
		t.Fatalf("granting a contributor also added a viewer: %v", viewers)
	}
	if len(contributors) != 1 {
		t.Fatalf("contributors = %v, want bob", contributors)
	}

	// A contributor can see the session — a grant to write into
	// something you can't read would be nonsense — so the roster moves.
	got := sessionIDs(t, asCaller(t, http.MethodGet, srv.URL+"/sessions", mockOtherCaller, nil))
	var found bool
	for _, id := range got {
		if id == "smoke-session" {
			found = true
		}
	}
	if !found {
		t.Fatalf("bob sees %v, want smoke-session now that he contributes to it", got)
	}
}

// Owner transfer is refused with a reason rather than ignored. A
// caller who sends one has a mistaken model of the endpoint, and
// dropping the field would let them keep it.
func TestMockACL_OwnerIsRefusedNotIgnored(t *testing.T) {
	srv := newMockServer(t)
	const path = "/sessions/ops-triage/acl"

	for _, tc := range []struct{ name, body string }{
		{"transfer", `{"owner":"` + mockOtherCaller + `"}`},
		{"clear", `{"owner":""}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := patchAs(t, srv, path, mockDefaultCaller, tc.body)
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("want 400, got %d", resp.StatusCode)
			}
		})
	}

	// And it really didn't happen.
	owner, _, _ := decodeACL(t,
		asCaller(t, http.MethodGet, srv.URL+path, mockDefaultCaller, nil))
	if owner != mockDefaultCaller {
		t.Fatalf("owner = %q after two refused transfers, want %q", owner, mockDefaultCaller)
	}
}

// ─── Titles ──────────────────────────────────────────────────────────

// `title` is required and `""` is a real instruction. "Clear the name"
// and "leave it alone" are different requests, so an omitted key is a
// 400 rather than a silent no-op 200 — which is what a client with a
// typo'd field name would otherwise get.
func TestMockTitle_OmittedKeyIsRefused(t *testing.T) {
	srv := newMockServer(t)

	resp, err := http.Post(srv.URL+"/sessions/smoke-session/title",
		"application/json", strings.NewReader(`{"name":"oops"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 for an omitted title key, got %d", resp.StatusCode)
	}
}

// The response reports what was STORED, after normalization — which is
// not what was sent. A client that renders its own string shows the
// operator a name the picker will not.
func TestMockTitle_EchoesTheStoredNameNotTheSentOne(t *testing.T) {
	srv := newMockServer(t)

	long := strings.Repeat("x", maxTitleRunes+20)
	out := postJSON(t, srv, "/sessions/smoke-session/title", `{"title":"  `+long+`  "}`)
	stored, _ := out["title"].(string)
	if n := len([]rune(stored)); n != maxTitleRunes {
		t.Fatalf("stored title is %d runes, want the %d-rune cap applied", n, maxTitleRunes)
	}

	// `persisted: false` is NOT an error — it is the norm for a session
	// with no durable row, and the rename did take effect. A client
	// that treats it as a failure reports every successful rename as
	// broken.
	if persisted, ok := out["persisted"].(bool); !ok || persisted {
		t.Fatalf("persisted = %#v, want an explicit false", out["persisted"])
	}

	rows := getSessionRows(t, srv)
	for _, row := range rows {
		if row["sessionID"] == "smoke-session" && row["title"] != stored {
			t.Fatalf("roster shows title %#v, want the stored %q", row["title"], stored)
		}
	}
}

// Clearing is a rename to nothing, and the honest encoding of "no
// name" on the wire is an ABSENT key — `title` is optional, and a
// client falling back to the session id has to be able to tell.
func TestMockTitle_EmptyStringClearsTheName(t *testing.T) {
	srv := newMockServer(t)

	postJSON(t, srv, "/sessions/ops-triage/title", `{"title":""}`)
	for _, row := range getSessionRows(t, srv) {
		if row["sessionID"] != "ops-triage" {
			continue
		}
		if _, present := row["title"]; present {
			t.Fatalf("row still carries title %#v after a clear", row["title"])
		}
		return
	}
	t.Fatal("ops-triage vanished from the roster")
}
