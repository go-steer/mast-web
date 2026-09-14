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
	"strings"
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
// Contributors are omitted: the SPA has no write-vs-read distinction
// to draw yet, so modelling one here would be fiction with a test
// attached.
type mockSessionACL struct {
	owner   string
	viewers []string
}

// canRead mirrors pkg/auth/authorize.go's Read row: owner or viewer.
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
	return false
}

// mockSessionACLs grants the fixture roster to two operators, arranged
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
var mockSessionACLs = map[string]mockSessionACL{
	"smoke-session": {owner: mockDefaultCaller},
	"ops-triage":    {owner: mockDefaultCaller, viewers: []string{mockOtherCaller}},
	"docs-writer":   {owner: mockOtherCaller, viewers: []string{mockDefaultCaller}},
	"repo-indexer":  {owner: mockDefaultCaller},
}

// aclFor returns the ACL for a session id. An unknown id — anything
// created at runtime by POST /sessions — is owned by whoever is
// asking, which is the same answer the real create handler gives.
func aclFor(sid string, c mockCaller) mockSessionACL {
	if acl, ok := mockSessionACLs[sid]; ok {
		return acl
	}
	return mockSessionACL{owner: c.identity}
}

// visibleSessions filters the roster the way core-agent's listSessions
// does (reg.ListAuthorized + store.ListVisibleTo, handlers.go:408-467):
// a caller sees exactly the sessions they may read. Anonymous sees
// none — not an error, an empty list, same as upstream.
func visibleSessions(c mockCaller) []any {
	out := make([]any, 0, len(mockSessions))
	for _, s := range mockSessions {
		sid, _ := s["sessionID"].(string)
		if !aclFor(sid, c).canRead(c.identity) {
			continue
		}
		out = append(out, s)
	}
	return out
}
