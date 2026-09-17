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
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
)

// The mock's identity layer: who is calling, and which sessions that
// caller may see.
//
// Until now the mock had exactly one user. That made it structurally
// incapable of catching the bug the whole ACL design exists to
// prevent — a browser showing one operator another operator's
// sessions — because there was never a second operator for it to leak
// to. Everything here exists so a Playwright spec can be two people.
//
// ─── Why a cookie ───────────────────────────────────────────────────
//
// In the smoke topology the browser talks to this mock DIRECTLY
// (playwright.config.*: `go run ./cmd/mast-web-server --mode=mock`).
// There is no BFF in between, so nothing upstream is asserting an
// identity, and the SPA's own requests go out through `fetch` and
// through `EventSource` — and EventSource cannot set a header at all.
// A cookie is the one identity carrier that rides on both, and
// `context.addCookies` is how a spec picks who it is.
//
// The header is still first, because that is what a real deployment
// sends: mast-web-server's proxy sets X-Asserted-Caller from its own
// auth mode (proxy.go:223) after deleting any client-supplied copy
// (proxy.go:201). Running the mock behind the BFF therefore behaves
// like the real thing without the cookie being involved.
const (
	// mockCallerCookie is the smoke suite's identity switch.
	mockCallerCookie = "mock_caller"

	// mockDefaultCaller is who you are when you say nothing. Every
	// pre-existing smoke spec says nothing, which is why the default
	// still sees the roster it has always seen.
	mockDefaultCaller = "smoke@example.com"

	// mockOtherCaller is the second operator. Named here rather than
	// spelled into fixtures at each use so the multi-user spec and the
	// Go tests can't drift apart on a typo.
	mockOtherCaller = "bob@example.com"
)

// mockCaller is the resolved identity for one request, in the shape
// GET /whoami answers with. `source` uses core-agent's vocabulary
// (pkg/attach/handlers.go: bearer | mtls | iap | asserted | anonymous)
// plus `mock` for the two ways only this server can be told.
type mockCaller struct {
	identity string
	source   string
}

// anonymous reports whether the request resolved to nobody. Kept as a
// method rather than an `== ""` at each site because the write paths
// below turn it into a 401 and that deserves a name.
func (c mockCaller) anonymous() bool { return c.identity == "" }

// callerOf resolves the caller: asserted header, then cookie, then the
// default. An explicitly EMPTY header or cookie means anonymous —
// that is the only way to test the unauthenticated paths, since the
// default would otherwise make every request somebody.
func callerOf(r *http.Request) mockCaller {
	if vals, ok := r.Header[http.CanonicalHeaderKey(assertedCallerHeader)]; ok && len(vals) > 0 {
		id := strings.TrimSpace(vals[0])
		if id == "" {
			return mockCaller{source: "anonymous"}
		}
		return mockCaller{identity: id, source: "asserted"}
	}
	if ck, err := r.Cookie(mockCallerCookie); err == nil {
		id := strings.TrimSpace(ck.Value)
		if id == "" {
			return mockCaller{source: "anonymous"}
		}
		return mockCaller{identity: id, source: "mock"}
	}
	return mockCaller{identity: mockDefaultCaller, source: "mock"}
}

// mockSessionACL is the out-of-band half of a fixture row: core-agent
// persists {Owner, Viewers, Contributors} alongside a session
// (pkg/attach/session_acl_store.go) but GET /sessions does NOT emit
// any of it — a descriptor carries {app, user, sessionID, ...} and
// nothing else. Keeping the ACL in a side table rather than as extra
// keys on mockSessions is what stops the mock from inventing a wire
// field the real backends don't have.
//
// Contributors arrived with the v1.10.0 ACL endpoint (core-agent#797).
// They were honoured by Authorize and persisted on the session row from
// the day multi-session shipped; what was missing was any way for a
// caller to put an identity in one. They are modelled here — and kept
// as their own word, never folded into viewers — because the
// difference is the entire point of the endpoint: a viewer watches, a
// contributor writes into the session. The escalation case is a
// watcher agent opening a session, paging a human, and the human's
// reply arriving under their own identity and needing to be allowed to
// land.
type mockSessionACL struct {
	owner        string
	viewers      []string
	contributors []string
}

// canRead mirrors pkg/auth/authorize.go's Read row: owner, viewer or
// contributor. A contributor who could write but not see what they
// were writing into would be a nonsense grant.
func (a mockSessionACL) canRead(identity string) bool {
	if identity == "" {
		return false
	}
	if a.owner == identity {
		return true
	}
	for _, v := range a.viewers {
		if v == identity {
			return true
		}
	}
	for _, c := range a.contributors {
		if c == identity {
			return true
		}
	}
	return false
}

// canAdmin mirrors the ActionSessionAdmin row: the owner, and nobody
// else the mock models (there is no admin identity here).
//
// Both ACL verbs are gated on it, the read as hard as the write. That
// is deliberate upstream and worth repeating: the ACL names the other
// people who can see an incident, and letting a contributor enumerate
// their co-responders is a disclosure the matrix doesn't otherwise
// grant. It is also why a share dialog can only ever be populated for
// a session you own.
func (a mockSessionACL) canAdmin(identity string) bool {
	return identity != "" && a.owner == identity
}

// mockACLs grants the fixture roster to two operators, arranged
// so that BOTH of them see one session they own and one somebody else
// shared with them. A roster where the second identity only ever sees
// less than the first can be satisfied by a client that drops rows at
// random; this one cannot.
//
// The owner always matches the row's `user`, because that is what the
// real thing does: pkg/compose/multi_session.go:481 creates the ADK
// session with `agent.WithSession(caller.Identity, sid)`, so a session
// made through POST /sessions has UserID == its ACL Owner. That
// equality is the whole basis for the browser deriving ownership from
// a field the wire does carry, so the mock has to honour it.
// It is also mutable now, which it was not before v1.10.0 gave the ACL
// a PATCH verb. That means a mutex: GET /sessions reads this roster on
// every request and a handler writing it in place would be a data
// race, not a modelling choice.
var mockACLs = mockACLStore{
	m: map[string]mockSessionACL{
		"smoke-session": {owner: mockDefaultCaller},
		"ops-triage":    {owner: mockDefaultCaller, viewers: []string{mockOtherCaller}},
		"docs-writer":   {owner: mockOtherCaller, viewers: []string{mockDefaultCaller}},
		"repo-indexer":  {owner: mockDefaultCaller},
	},
}

type mockACLStore struct {
	mu sync.Mutex
	m  map[string]mockSessionACL
}

// get returns a copy. The lists are copied too: handing a caller the
// backing array would let a later append inside a PATCH mutate a slice
// somebody else is ranging over.
func (s *mockACLStore) get(sid string) (mockSessionACL, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	acl, ok := s.m[sid]
	if !ok {
		return mockSessionACL{}, false
	}
	return mockSessionACL{
		owner:        acl.owner,
		viewers:      append([]string(nil), acl.viewers...),
		contributors: append([]string(nil), acl.contributors...),
	}, true
}

// amend applies a read-modify-write under the lock, the way upstream's
// AmendACL does. Doing the read in the handler instead would let two
// concurrent PATCHes each carry the other's omitted list forward from
// a stale snapshot, silently losing one edit — to an authorization
// decision, which is the worst place to lose one.
func (s *mockACLStore) amend(sid string, fn func(mockSessionACL) mockSessionACL) mockSessionACL {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := fn(s.m[sid])
	s.m[sid] = next
	return next
}

// reset restores the seeded roster. Test-only, alongside the pause
// gates: an ACL a spec edited is exactly the kind of state that leaks
// into the next one.
func (s *mockACLStore) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m = map[string]mockSessionACL{
		"smoke-session": {owner: mockDefaultCaller},
		"ops-triage":    {owner: mockDefaultCaller, viewers: []string{mockOtherCaller}},
		"docs-writer":   {owner: mockOtherCaller, viewers: []string{mockDefaultCaller}},
		"repo-indexer":  {owner: mockDefaultCaller},
	}
}

// aclFor returns the ACL for a session id. An unknown id — anything
// created at runtime by POST /sessions — is owned by whoever is
// asking, which is the same answer the real create handler gives.
func aclFor(sid string, c mockCaller) mockSessionACL {
	if acl, ok := mockACLs.get(sid); ok {
		return acl
	}
	return mockSessionACL{owner: c.identity}
}

// visibleSessions filters the roster the way core-agent's listSessions
// does (reg.ListAuthorized + store.ListVisibleTo, handlers.go:408-467):
// a caller sees exactly the sessions they may read. Anonymous sees
// none — not an error, an empty list, same as upstream.
//
// Rows are copied on the way out because a title set through POST
// /title is overlaid here rather than written into mockSessions:
// the fixture roster is read concurrently by every request, and the
// overlay keeps it immutable. See mockTitles.
func visibleSessions(c mockCaller) []any {
	out := make([]any, 0, len(mockSessions))
	for _, s := range mockSessions {
		sid, _ := s["sessionID"].(string)
		if !aclFor(sid, c).canRead(c.identity) {
			continue
		}
		out = append(out, sessionRow(s, sid))
	}
	return out
}

// ─── Titles (v1.10.0, core-agent#808) ────────────────────────────────
//
// A side table for the same reason the ACL is one: mockSessions is a
// package-level fixture read by every GET /sessions, and renaming a
// session by writing into it is a data race. Overlaying keeps the
// fixture immutable and makes the rename observably per-process,
// which is exactly the `persisted: false` the real endpoint reports
// for a session with no durable row.
var mockTitles = struct {
	mu sync.Mutex
	m  map[string]string
}{m: map[string]string{}}

// setMockSessionTitle stores the normalized title. The empty string is
// a real instruction — clear the name — and is stored as one rather
// than deleted, so the overlay can shadow a fixture row's own title.
func setMockSessionTitle(sid, title string) {
	mockTitles.mu.Lock()
	defer mockTitles.mu.Unlock()
	mockTitles.m[sid] = title
}

func resetMockSessionTitles() {
	mockTitles.mu.Lock()
	defer mockTitles.mu.Unlock()
	mockTitles.m = map[string]string{}
}

// sessionRow copies a fixture row and applies any title override.
func sessionRow(s map[string]any, sid string) map[string]any {
	mockTitles.mu.Lock()
	title, overridden := mockTitles.m[sid]
	mockTitles.mu.Unlock()
	if !overridden {
		return s
	}
	out := make(map[string]any, len(s)+1)
	for k, v := range s {
		out[k] = v
	}
	if title == "" {
		// Cleared. `title` is optional on the wire, so the honest
		// encoding of "no name" is an absent key, not an empty string —
		// a client falling back to the session id has to be able to
		// tell.
		delete(out, "title")
	} else {
		out["title"] = title
	}
	return out
}

// ─── The ACL endpoints (v1.10.0, core-agent#797) ─────────────────────

// aclBody is the wire shape of GET /sessions/{sid}/acl and of a
// successful PATCH. The two lists are NEVER omitted, even when empty:
// this is the endpoint whose whole purpose is reporting who is on the
// ACL, and a client that had to treat a missing key and an empty list
// alike would be back to guessing.
func aclBody(acl mockSessionACL) map[string]any {
	viewers := acl.viewers
	if viewers == nil {
		viewers = []string{}
	}
	contributors := acl.contributors
	if contributors == nil {
		contributors = []string{}
	}
	return map[string]any{
		"owner":        acl.owner,
		"viewers":      viewers,
		"contributors": contributors,
	}
}

// getACL backs GET /sessions/{sid}/acl.
//
// DENIAL IS 404, NOT 403, and that is not sloppiness — upstream makes
// an unauthorized session indistinguishable from a missing one on
// purpose, so that probing the API cannot enumerate other people's
// sessions. The cost is that a client cannot feature-detect this route
// by trying it: a 404 means "old server" or "not yours" and nothing
// tells the two apart. Read the negotiated protocol version instead
// (AttachClient.supportsACL). Modelling the 403 here would be
// friendlier and would teach the SPA a lie.
func (h *mockHandler) getACL(w http.ResponseWriter, r *http.Request, sid string) {
	c := callerOf(r)
	acl := aclFor(sid, c)
	if !acl.canAdmin(c.identity) {
		writeError(w, http.StatusNotFound, "session not found\n")
		return
	}
	writeJSON(w, http.StatusOK, aclBody(acl))
}

// patchACL backs PATCH /sessions/{sid}/acl.
//
// The list fields are pointers so absent and empty stay
// distinguishable, which is what makes this a PATCH rather than a PUT:
// a field the caller didn't send is left alone, and `[]` clears it.
// Without that, `{"contributors":["responder"]}` would silently wipe
// the viewers somebody set last week.
//
// `owner` is accepted only so it can be REFUSED with a reason. A
// caller sending one has a mistaken model of what this endpoint does,
// and dropping the field on the floor would let them go on believing
// it — the same silent-failure shape #797 was filed about. Transfer is
// not a thing this API does.
func (h *mockHandler) patchACL(w http.ResponseWriter, r *http.Request, sid string) {
	c := callerOf(r)
	acl := aclFor(sid, c)
	if !acl.canAdmin(c.identity) {
		writeError(w, http.StatusNotFound, "session not found\n")
		return
	}
	var req struct {
		Owner        *string   `json:"owner"`
		Viewers      *[]string `json:"viewers"`
		Contributors *[]string `json:"contributors"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "acl: malformed body\n")
		return
	}
	drainBody(r)
	if req.Owner != nil && *req.Owner == "" {
		writeError(w, http.StatusBadRequest,
			"acl: owner cannot be cleared; send the current owner or omit the field\n")
		return
	}
	if req.Owner != nil && *req.Owner != acl.owner {
		writeError(w, http.StatusBadRequest, "acl: owner is not transferable\n")
		return
	}
	stored := mockACLs.amend(sid, func(cur mockSessionACL) mockSessionACL {
		if cur.owner == "" {
			// A session created at runtime has no seeded row; the
			// caller who may administer it is its owner by definition.
			cur.owner = acl.owner
		}
		if req.Viewers != nil {
			cur.viewers = append([]string(nil), *req.Viewers...)
		}
		if req.Contributors != nil {
			cur.contributors = append([]string(nil), *req.Contributors...)
		}
		return cur
	})
	// Echo what was stored rather than answering 204, so a caller can
	// see what normalization did to what it sent without a second
	// round trip.
	writeJSON(w, http.StatusOK, aclBody(stored))
}

// resetShareState backs DELETE /_mock/share-state — the ACL and title
// counterpart to DELETE /_mock/pause-gates. Test-only.
func (h *mockHandler) resetShareState(w http.ResponseWriter, _ *http.Request) {
	mockACLs.reset()
	resetMockSessionTitles()
	writeEmpty(w, http.StatusNoContent)
}
