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
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// defaultMockFixture is the stream every smoke test and every
// `npm run dev` session sees unless it asks for another. That makes it
// the mock's default picture of the world, which is why the spec guard
// in mock_spec_test.go checks this one rather than the set.
const defaultMockFixture = "001-happy-turn"

// wireProtocolVersion is the attach-protocol version this mock models —
// core-tui/docs/sse-event-stream-protocol.md. Bumping it is the first
// step of a protocol catch-up, and TestMock_DefaultFixtureMatchesSpec
// will then fail until the mock's advertised capabilities agree.
//
// It exists because the alternative is what actually happened: the
// protocol went 1.4.0 → 1.7.0 over a month, the mock stayed at 1.4.0,
// every test agreed with the mock, and we shipped a Stop button that
// parked sessions (#68). Nothing was wrong with any individual test.
// The problem was that no test asserted the mock was current, so being
// out of date was not a failure condition.
const wireProtocolVersion = "1.12.0"

// mockPublishedEvents are the SSE events the mock emits from its own
// handlers rather than from fixture replay — the pause gate's
// transitions and the wake that follows an inject. A consumer can only
// be tested against these if the mock advertises them, so the guard
// checks that it does.
var mockPublishedEvents = []string{"pause", "wake"}

// mockHandler serves the fake attach-protocol endpoints the SPA hits
// during connect + normal operation. Fed from JSONL conformance
// fixtures under cfg.fixturesDir. Same shape the Python mock served,
// re-implemented in Go so the whole repo is one language and the
// production binary covers dev use cases too.
type mockHandler struct {
	fixturesDir  string
	fixture      string
	frameDelayMs int

	// Turn-request tally, readable at GET /_mock/turn-requests.
	//
	// The mock replays a fixture on connect and streams it regardless
	// of what the SPA posts, so nothing about the rendered transcript
	// reveals how many turns the SPA *asked* for. That blind spot let
	// a real double-turn ship: /inject already wakes the agent
	// (core-agent pkg/agent/inbox.go), so the paired /inject + /wake
	// ran every prompt twice, and no fixture could show it. Counting
	// the posts is the only way the suite can see it.
	mu     sync.Mutex
	counts map[string]int
	// prompts is the inbox-id sequence behind nextPromptID.
	prompts int

	// Operator pause gate (protocol v1.5.0) and the fan-out that makes
	// its events visible to streams already open. See mock_pause.go —
	// this is the one piece of the mock that keeps real state, because
	// a gate whose only state is "open" isn't a gate.
	gates pauseGates
	hub   mockHub
}

// countPost tallies one write against an endpoint name.
func (h *mockHandler) countPost(endpoint string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.counts == nil {
		h.counts = make(map[string]int)
	}
	h.counts[endpoint]++
}

// nextPromptID mints the inbox id an inject or a prompted wake reports
// back (v1.10.0, core-agent#840). Monotonic and per-process, which is
// all a correlation handle has to be: the only property a consumer can
// rely on is that two injects get two different ids.
func (h *mockHandler) nextPromptID() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.prompts++
	return fmt.Sprintf("mock-prompt-%d", h.prompts)
}

// turnRequests reports the tally and, on DELETE, clears it. Specs
// reset before typing so a count reflects one prompt rather than
// everything since boot.
func (h *mockHandler) turnRequests(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r.Method == http.MethodDelete {
		h.counts = make(map[string]int)
	}
	out := make(map[string]int, len(h.counts))
	for k, v := range h.counts {
		out[k] = v
	}
	writeJSON(w, http.StatusOK, out)
}

// Session rows use the canonical {app, user, sessionID} wire shape the
// real backends emit (core-agent docs/attach-mode-design.md), NOT the
// snake_case the mock invented for itself.
//
// The invention cost us #41: listSessions understood only the mock's
// shape, so every session rendered as `undefined` the first time the
// SPA met a real daemon, and 144 green tests had nothing to say about
// it. The client is deliberately tolerant of both shapes now — that's
// correct defensiveness against backends in the wild — but the mock has
// to model the wire truth, or the tolerant branch is the only one
// anything ever exercises. TestMock_SessionRowsUseCanonicalWireShape in
// mock_test.go is the guard — it requires {app, user, sessionID} on
// every row and forbids the snake_case spellings outright.
//
// The ACL that decides which of these rows a given caller sees is
// deliberately NOT here: core-agent keeps Owner/Viewers alongside a
// session and emits neither, so modelling it as extra keys would
// invent a wire field the real backends do not have. It lives in
// mock_acl.go instead.

// mockSession is the canned session the SPA auto-selects on connect.
// Kept minimal — just enough to open an SSE stream. Always first in
// mockSessions so single-session consumers (smoke tests, a shell's
// auto-select) keep landing on it.
var mockSession = map[string]any{
	"app":             "mast-web-mock",
	"user":            mockDefaultCaller,
	"sessionID":       "smoke-session",
	"has_event_log":   true,
	"status":          "active",
	"last_touched_at": "2026-07-20T12:00:00Z",
}

// mockSessions is the roster returned from GET /sessions. More than
// one because spatial.html opens a live terminal per session — a
// single-entry list makes the multi-panel workspace impossible to see
// without hand-forging session IDs. Each extra session streams a
// different fixture (sessionFixtures) so the panels don't all show
// the same transcript.
//
// `title` is the optional v1.6.0 field: a short human label a client
// shows instead of the opaque session ID. Two rows carry one and two
// don't, because both paths render and a roster where every row has a
// title would never exercise the fallback.
var mockSessions = []map[string]any{
	mockSession,
	{
		"app":             "core-agent",
		"user":            mockDefaultCaller,
		"sessionID":       "ops-triage",
		"has_event_log":   true,
		"status":          "active",
		"last_touched_at": "2026-07-20T11:52:00Z",
		"title":           "Paging alert on checkout-api",
	},
	{
		// The one row the default caller does NOT own — bob shares it
		// with them (mockACLs). `user` is bob because the real
		// create path sets the ADK UserID from the caller's identity,
		// so "user is not me" is exactly what a shared session looks
		// like on the wire. Keep the two in step.
		"app":             "core-agent",
		"user":            mockOtherCaller,
		"sessionID":       "docs-writer",
		"has_event_log":   true,
		"status":          "idle",
		"last_touched_at": "2026-07-20T09:14:00Z",
		"title":           "Rewrite the attach quickstart",
	},
	{
		"app":             "mast",
		"user":            mockDefaultCaller,
		"sessionID":       "repo-indexer",
		"has_event_log":   true,
		"status":          "active",
		"last_touched_at": "2026-07-20T11:59:00Z",
	},
}

// sessionFixtures picks a per-session fixture for GET .../events when
// the request doesn't name one explicitly. Unlisted session IDs
// (including smoke-session) fall through to the server's --fixture,
// so the smoke suite's expectations are unaffected.
var sessionFixtures = map[string]string{
	"ops-triage":   "003-tool-result-with-latency",
	"docs-writer":  "004-observer-mode-usage-update-only",
	"repo-indexer": "002-cost-ceiling-mid-turn",
}

// Sidebar-stub payloads. Values chosen so the sidebar panels populate
// to something visible rather than empty.
var (
	stubStatus = map[string]any{
		"model":       "mock-model-1.5",
		"provider":    "mock",
		"turn_state":  "idle",
		"context_pct": 8,
		"perm_mode":   "prompt",
	}
	// Includes a couple of <server>_<tool>-namespaced entries with
	// source:"other" (no explicit `server` field) — mirrors the real
	// backend's current behavior (pkg/attachadapter/capabilities.go
	// doesn't populate MCP attribution yet) so the SPA's name-prefix
	// fallback bucketing in mast.listMcpServers() is exercised against
	// the mock, not just the aspirational fully-attributed shape.
	//
	// It also spans four source families, which is the point of most of
	// these rows: a catalog of five built-ins renders through /tools'
	// single-source path and never touches the grouping, the folding of
	// several skill:<name> sources into one heading, or the
	// `/tools <source>` filter (core-tui#289, mast-web#59). A mock that
	// only models the easy shape is how a client ships believing it
	// handles the hard one.
	stubTools = map[string]any{
		"tools": []map[string]any{
			{"name": "fs_read", "description": "Read files", "source": "builtin", "gate_state": "allowed"},
			{"name": "fs_write", "description": "Write files", "source": "builtin", "gate_state": "prompted"},
			{"name": "bash_exec", "description": "Run shell commands", "source": "builtin", "gate_state": "prompted"},
			{"name": "kube_get", "description": "kubectl get", "source": "other", "gate_state": "allowed"},
			{"name": "kube_apply", "description": "kubectl apply", "source": "other", "gate_state": "prompted"},
			// Flattened MCP attribution: core-agent reports the server's
			// own name in `source` rather than the bare word "mcp".
			{"name": "gke_clusters_list", "description": "List GKE clusters", "source": "gke", "gate_state": "allowed"},
			{"name": "gke_nodes_list", "description": "List cluster nodes", "source": "gke", "gate_state": "allowed"},
			// Unflattened source/server pair — the older shape, still on
			// the wire from some producers, which clients must normalize
			// to the same bucket as the rows above.
			{"name": "gh_pr_view", "description": "Show a pull request", "source": "mcp", "server": "github", "gate_state": "allowed"},
			// Two skills, one heading: the fold is only visible when
			// there is more than one to fold.
			{"name": "review_diff", "description": "Review a diff", "source": "skill:review", "gate_state": "allowed"},
			{"name": "write_adr", "description": "Write a decision record", "source": "skill:adr", "gate_state": "allowed"},
			{"name": "delegate", "description": "Hand work to a subagent", "source": "subagent", "gate_state": "prompted"},
		},
	}
	stubAgents = map[string]any{
		"agents": []map[string]any{
			{"name": "researcher", "description": "Research + summarize"},
			{"name": "implementer", "description": "Write + edit code"},
		},
	}
	stubUsage = map[string]any{
		"overall": map[string]any{"tokens_in": 45, "tokens_out": 8, "cost_usd": 0.00012, "turns": 1},
		"per_model": map[string]any{
			"mock-model-1.5": map[string]any{"tokens_in": 45, "tokens_out": 8, "cost_usd": 0.00012, "turns": 1},
		},
		"per_turn": []any{},
	}
	// stubGuardrails backs GET /sessions/{sid}/guardrails (core-agent
	// #670/#671). Untripped by default so the smoke happy-path doesn't
	// show a paused session; fixtures that want to exercise the
	// cost-ceiling reset UX can still hit turn-error separately.
	stubGuardrails = map[string]any{
		"watchdog": map[string]any{"mode": "warn", "tripped": false},
		"cost_ceiling": map[string]any{
			"max_turn_usd":     1.0,
			"max_session_usd":  10.0,
			"session_cost_usd": 0.02,
			"tripped":          false,
			"would_retrip":     false,
		},
		"halted": false,
	}
	// stubSubagentsCatalog backs GET /sessions/{sid}/subagents — the
	// configured/spawnable roster (core-agent#627/#634), distinct from
	// stubAgents (the live roster returned by GET .../agents).
	// One row carries `tools` (v1.9.0, core-agent#768) and one does
	// not, because the absent case is the one a client gets wrong.
	// ABSENCE MEANS UNKNOWN, NOT NONE: the key is omitted by a
	// pre-1.9.0 daemon and equally for a subagent configured with no
	// grant of its own, so a renderer that prints "no tools" for a
	// missing key is guessing — and a catalog where every row had one
	// would never make it say so out loud. The three the runtime wires
	// into every subagent regardless (return_result, report_alert,
	// schedule_next_turn) are deliberately not listed: they are a
	// property of the runtime, not of this configuration.
	stubSubagentsCatalog = map[string]any{
		"subagents": []map[string]any{
			{
				"name":        "researcher",
				"description": "Research + summarize",
				"model":       "mock-model-1.5",
				"modes":       []string{"sync", "async"},
				"tools": []map[string]any{
					{"name": "fs_read", "description": "Read files", "source": "builtin"},
					{"name": "gke_clusters_list", "description": "List GKE clusters", "source": "gke"},
				},
			},
			{
				"name":        "implementer",
				"description": "Write + edit code",
				"model":       "mock-model-1.5",
				"modes":       []string{"async"},
			},
		},
	}
	// knownSubagentNames gates the subagent turn drill-down stub —
	// mirrors the names in stubAgents / stubSubagentsCatalog so the
	// 404 + `available` roster path (core-agent#638/#687) is
	// exercisable against an unknown name too.
	knownSubagentNames = []string{"researcher", "implementer"}
)

// finishedSubagentName is the subagent that has already terminated on
// its own. It exists so POST .../agents/{name}/stop can answer both of
// v1.12.0's cases (core-agent#897) without any setup: stopping
// `researcher` reports stopped:true, stopping this one reports
// stopped:false with the status it ended as. A mock with only live
// subagents leaves the case the change was filed about unreachable,
// which is how "stopped" kept meaning the wrong thing for four minor
// versions.
const finishedSubagentName = "implementer"

func newMockHandler(cfg config) (*mockHandler, error) {
	if cfg.fixturesDir == "" {
		return nil, errors.New("mock: --fixtures-dir required")
	}
	// Verify default fixture exists at startup so the operator sees a
	// clear error before we bind + start serving 404s from the
	// fallback path.
	if _, err := loadFixture(cfg.fixturesDir, cfg.fixture); err != nil {
		return nil, fmt.Errorf("default fixture %q: %w", cfg.fixture, err)
	}
	return &mockHandler{
		fixturesDir:  cfg.fixturesDir,
		fixture:      cfg.fixture,
		frameDelayMs: cfg.frameDelayMs,
	}, nil
}

// registerMockRoutes wires every endpoint the SPA hits during connect
// + normal operation.
//
// We used to register per-endpoint wildcards like `{endpoint}` on
// several paths, but Go 1.22+ ServeMux is strict about ambiguous
// patterns — `{sid}/perms/{endpoint}` conflicts with `{app}/{sid}/
// events`. Simpler + more robust: register a per-method catchall on
// the `/sessions/` prefix and dispatch inside the handler by
// inspecting the URL segments. Non-session endpoints (/whoami,
// /peers, /.well-known/...) stay literal.
func registerMockRoutes(mux *http.ServeMux, h *mockHandler) {
	// Session-scoped catchalls per method — dispatch happens inside.
	mux.HandleFunc("GET /sessions", h.listSessions)
	mux.HandleFunc("GET /sessions/", h.sessionGet)
	mux.HandleFunc("POST /sessions", h.createSession)
	mux.HandleFunc("POST /sessions/", h.sessionPost)
	mux.HandleFunc("DELETE /sessions/", h.deleteSession)
	// PATCH has exactly one route (the v1.10.0 ACL) and the verb is
	// load-bearing there — omitted and `[]` mean different things,
	// which a PUT cannot express. Dispatched inside like the rest.
	mux.HandleFunc("PATCH /sessions/", h.sessionPatch)

	// Test-only introspection. Not part of the attach protocol —
	// the underscore marks it as belonging to the mock, not to
	// anything a real backend serves.
	mux.HandleFunc("GET /_mock/turn-requests", h.turnRequests)
	mux.HandleFunc("DELETE /_mock/turn-requests", h.turnRequests)
	// The pause gate is the mock's only persistent state, so it's also
	// the only thing a spec can leak into the next one. Let them clear
	// it rather than restart the server between cases.
	mux.HandleFunc("DELETE /_mock/pause-gates", h.resetGates)
	// Same problem, newer state: an ACL amended or a session renamed by
	// one spec would otherwise be what the next one starts from.
	mux.HandleFunc("DELETE /_mock/share-state", h.resetShareState)

	// Session-agnostic endpoints.
	mux.HandleFunc("GET /whoami", h.whoami)
	mux.HandleFunc("GET /peers", h.peers)
	mux.HandleFunc("GET /.well-known/agent-card.json", h.agentCard)

	// CORS preflight — scoped to endpoints the SPA sends non-simple
	// requests to. Can't use a bare `OPTIONS /` because Go's ServeMux
	// treats method+catchall combinations as ambiguous vs. any
	// method-less pattern like /healthz. Scope narrowly instead.
	// PATCH is never a simple request, so the ACL edit always preflights.
	mux.HandleFunc("OPTIONS /sessions", h.preflight)
	mux.HandleFunc("OPTIONS /sessions/", h.preflight)
	mux.HandleFunc("OPTIONS /whoami", h.preflight)
	mux.HandleFunc("OPTIONS /peers", h.preflight)
}

// sessionSegments returns { app, sid, tail... } from a session-scoped
// path. Accepts both the qualified form (/sessions/{app}/{sid}/...)
// and the shortcut form (/sessions/{sid}/...) — in the shortcut form
// app is empty and sid is parts[0].
//
// Callers dispatch on tail[0] for the "endpoint" name.
func sessionSegments(path string) (app, sid string, tail []string, ok bool) {
	rest := strings.TrimPrefix(path, "/sessions/")
	if rest == path {
		return "", "", nil, false
	}
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", "", nil, false
	}
	// Heuristic: if the second segment looks like a known endpoint
	// name, treat parts[0] as sid (shortcut form). Otherwise the first
	// two segments are {app, sid}.
	if len(parts) == 1 {
		return "", parts[0], nil, true
	}
	if isKnownSessionEndpoint(parts[1]) {
		return "", parts[0], parts[1:], true
	}
	return parts[0], parts[1], parts[2:], true
}

// isKnownSessionEndpoint returns true when the given segment name is
// one of the well-known per-session endpoints. Used by
// sessionSegments to disambiguate qualified vs. shortcut paths.
func isKnownSessionEndpoint(name string) bool {
	switch name {
	case "events", "inject", "wake", "interrupt", "status", "tools",
		"agents", "subagents", "guardrails", "usage", "context", "memory",
		"skills", "mcp", "pricing", "perms", "reload", "slash",
		// v1.5.0 operator pause gate.
		"pause", "resume",
		// v1.10.0 sharing + naming. Neither has a feature flag
		// upstream, so the only thing telling a client they exist is
		// wireProtocolVersion — which makes routing them here part of
		// what claiming 1.12.0 means, not an optional extra.
		"acl", "title":
		return true
	}
	return false
}

// ─── Handlers ────────────────────────────────────────────────────────

// listSessions answers the ACL-filtered roster for the calling
// identity — see mock_acl.go. The filtering is the point: core-agent
// scopes this list per caller precisely so it does not leak other
// operators' activity patterns, and a mock that hands everyone
// everything cannot fail the test that would catch us doing it.
func (h *mockHandler) listSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"sessions": visibleSessions(callerOf(r))})
}

// createSession stamps the new session's owner from the caller, the
// way handlers_create_session.go does. Two of its refusals are worth
// modelling because a client can provoke both:
//
//	401 — no authenticated caller. There are no anonymous sessions.
//	400 — the body named an `owner` that isn't the caller. Upstream
//	      rejects that rather than quietly ignoring it, so a client
//	      that tries to create-on-behalf-of learns it can't.
func (h *mockHandler) createSession(w http.ResponseWriter, r *http.Request) {
	c := callerOf(r)
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	drainBody(r)
	if c.anonymous() {
		writeError(w, http.StatusUnauthorized, "authenticated caller required to create a session\n")
		return
	}
	var req struct {
		Owner string `json:"owner"`
	}
	if len(body) > 0 {
		_ = json.Unmarshal(body, &req)
	}
	if req.Owner != "" && req.Owner != c.identity {
		writeError(w, http.StatusBadRequest, "owner must match the authenticated caller\n")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"app":       mockSession["app"],
		"user":      c.identity,
		"sessionID": "smoke-session-2",
		"url":       "http://" + r.Host + "/sessions/" + mockSession["app"].(string) + "/smoke-session-2",
	})
}

// deleteSession is Admin in the ACL matrix, and Admin is the owner
// alone — a viewer who can read a shared session still cannot destroy
// it. A caller who cannot even read it gets the same 403 rather than a
// 404, because distinguishing the two would tell them the session
// exists.
func (h *mockHandler) deleteSession(w http.ResponseWriter, r *http.Request) {
	_, sid, _, ok := sessionSegments(r.URL.Path)
	if !ok {
		writeError(w, http.StatusNotFound, "delete: malformed session path\n")
		return
	}
	if sid == "default" {
		writeError(w, http.StatusForbidden, "cannot delete bootstrap default session\n")
		return
	}
	c := callerOf(r)
	if acl := aclFor(sid, c); acl.owner != c.identity || c.anonymous() {
		writeError(w, http.StatusForbidden, "only the owner may delete a session\n")
		return
	}
	writeEmpty(w, http.StatusNoContent)
}

// sessionGet dispatches on the endpoint segment for GET requests
// against /sessions/... . Handles events (SSE), perms/stream (idle
// SSE), sidebar reads (status/tools/agents/subagents/guardrails/usage),
// the subagent turn drill-down (agents/{name}/events), and a
// fallthrough {} for optional-endpoint reads (memory/skills/mcp/
// pricing/perms).
func (h *mockHandler) sessionGet(w http.ResponseWriter, r *http.Request) {
	_, sid, tail, ok := sessionSegments(r.URL.Path)
	if !ok || len(tail) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	switch tail[0] {
	case "events":
		h.sseEvents(w, r)
	case "perms":
		// /perms/stream — long-lived SSE idle stream.
		if len(tail) >= 2 && tail[1] == "stream" {
			h.streamSSE(w, r, nil, "")
			return
		}
		// /perms (no /stream) — return {} for the perms read.
		writeJSON(w, http.StatusOK, map[string]any{})
	case "acl":
		h.getACL(w, r, sid)
	case "status":
		writeJSON(w, http.StatusOK, h.statusFor(sid))
	case "tools":
		writeJSON(w, http.StatusOK, stubTools)
	case "agents":
		// GET .../agents/{name}/events — subagent turn drill-down
		// (core-agent#638/#687). GET .../agents alone is the live
		// roster (unchanged).
		if len(tail) >= 3 && tail[1] != "" && tail[2] == "events" {
			h.subagentEvents(w, sid, tail[1])
			return
		}
		writeJSON(w, http.StatusOK, stubAgents)
	case "subagents":
		// Configured/spawnable roster (core-agent#627/#634), distinct
		// from the live roster above.
		writeJSON(w, http.StatusOK, stubSubagentsCatalog)
	case "guardrails":
		writeJSON(w, http.StatusOK, stubGuardrails)
	case "usage":
		writeJSON(w, http.StatusOK, stubUsage)
	default:
		// Unknown session read — return {} so the SPA doesn't 404
		// on optional endpoints we haven't explicitly modeled.
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}

// statusFor renders GET /sessions/{sid}/status with this session's
// pause gate folded in (core-agent PauseInfo). A client that attaches
// to an already-paused session never saw the `pause` event that closed
// it, so /status is the only way it can find out — without this the
// gate would be discoverable only by whoever happened to be watching.
//
// It also carries `turn_in_flight` (v1.12.0, core-agent#896), which is
// the one field on the whole wire that can say "parked, and the turn
// the park interrupted is STILL RUNNING". The gate's `interrupted`
// records that a turn was cancelled on the way in; the bool records
// whether that cancellation has finished unwinding. An operator
// staring at a hold banner needs to know which of the two they are
// looking at, and no other surface can tell them: pause outranks
// running in `state`, so the session says "paused" either way.
func (h *mockHandler) statusFor(sid string) map[string]any {
	out := make(map[string]any, len(stubStatus)+6)
	for k, v := range stubStatus {
		out[k] = v
	}
	gate := h.gates.get(sid)
	out["paused"] = gate.paused
	out["turn_in_flight"] = gate.turnInFlight
	// `state` is one field and pause outranks running in it — verbatim
	// from upstream's central pause projection. That ordering is the
	// whole reason turn_in_flight had to exist as a separate key, so
	// getting it backwards here would model away the problem.
	switch {
	case gate.paused:
		out["state"] = "paused"
		out["turn_state"] = "paused"
		out["paused_since"] = gate.since.UTC().Format(time.RFC3339Nano)
		out["pause_reason"] = gate.reason
		if gate.interrupted {
			out["interrupted"] = true
		}
	case gate.turnInFlight:
		out["state"] = "running"
		out["turn_state"] = "streaming"
	default:
		out["state"] = "idle"
	}
	return out
}

// subagentEvents backs GET /sessions/{app}/{sid}/agents/{name}/events
// (core-agent#638/#687). Returns a one-event stub for known names
// (knownSubagentNames); 404 + `available` roster otherwise, matching
// the real backend's contract so the SPA's error path is exercisable.
func (h *mockHandler) subagentEvents(w http.ResponseWriter, sid, name string) {
	for _, known := range knownSubagentNames {
		if name == known {
			writeJSON(w, http.StatusOK, map[string]any{
				"agent":             name,
				"parent_session_id": sid,
				"branches":          []string{},
				"events": []map[string]any{
					{
						"seq": 1,
						"event": map[string]any{
							"Author": name,
							"Content": map[string]any{
								"parts": []map[string]any{{"text": "mock subagent turn output from " + name}},
							},
						},
					},
				},
				"next_since": 2,
				"truncated":  false,
			})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{
		"error":             "unknown agent",
		"agent":             name,
		"parent_session_id": sid,
		"branches":          []string{},
		"available":         knownSubagentNames,
	})
}

// sessionPost dispatches on the endpoint segment for POST requests
// against /sessions/... . Handles the v1.5.0 pause gate (interrupt /
// pause / resume — see mock_pause.go, the only stateful handlers here),
// inject / wake (v1.10.0 envelopes, and the v1.11.0 gate semantics),
// title (v1.10.0), agents/{name}/stop (v1.12.0), slash/<name> (returns
// a markdown _render response), and a {} fallthrough for perms/allow /
// perms/deny etc.
func (h *mockHandler) sessionPost(w http.ResponseWriter, r *http.Request) {
	_, sid, tail, ok := sessionSegments(r.URL.Path)
	if !ok || len(tail) == 0 {
		drainBody(r)
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	if tail[0] == "inject" || tail[0] == "wake" {
		h.countPost(tail[0])
	}
	// The gate endpoints read their request body, so they can't be
	// downstream of the blanket drain the no-op endpoints rely on.
	switch tail[0] {
	case "interrupt":
		h.interrupt(w, r, sid)
		return
	case "pause":
		h.pause(w, r, sid)
		return
	case "resume":
		h.resume(w, r, sid)
		return
	}
	// Endpoints that read their body, for the same reason the gate ones
	// do — they can't sit downstream of the blanket drain below.
	switch tail[0] {
	case "inject", "wake":
		h.injectOrWake(w, r, sid, tail[0])
		return
	case "title":
		h.setTitle(w, r, sid)
		return
	case "acl":
		// PATCH is the ACL's mutating verb; a POST to it is not a route
		// upstream has. Fall through to the {} no-op rather than
		// inventing one.
	}
	drainBody(r)
	switch tail[0] {
	case "agents":
		// POST .../agents/{name}/stop (v1.5.0, semantics revised in
		// v1.12.0 #897).
		if len(tail) >= 3 && tail[1] != "" && tail[2] == "stop" {
			h.stopSubagent(w, sid, tail[1])
			return
		}
	case "slash":
		// v1.4.0-conformant response with the reserved _render
		// convention so the SPA's slash-render dispatcher exercises
		// the markdown path.
		name := "unknown"
		if len(tail) >= 2 {
			name = tail[1]
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"_render": "markdown",
			"body":    "**mock**: /slash/" + name + " accepted (no side effect).",
		})
		return
	case "guardrails":
		// POST .../guardrails/reset (core-agent#670/#671). Always
		// succeeds against the mock's permanently-untripped
		// stubGuardrails — there's nothing to actually re-trip.
		if len(tail) >= 2 && tail[1] == "reset" {
			writeJSON(w, http.StatusOK, map[string]any{
				"reset":      []string{"watchdog", "cost_ceiling"},
				"guardrails": stubGuardrails,
			})
			return
		}
	}
	// Everything else (perms/allow / perms/deny / perms/respond /
	// pricing/* / reload) — accept as no-op.
	writeJSON(w, http.StatusOK, map[string]any{})
}

// sessionPatch dispatches PATCH against /sessions/... . One route
// today — the v1.10.0 ACL — but registered by method like the others
// so the next one isn't a special case.
func (h *mockHandler) sessionPatch(w http.ResponseWriter, r *http.Request) {
	_, sid, tail, ok := sessionSegments(r.URL.Path)
	if !ok || len(tail) == 0 || tail[0] != "acl" {
		drainBody(r)
		// Not a route. 404 rather than the {} the POST fallthrough
		// gives: a PATCH is a mutation, and answering a cheerful 200 to
		// one that changed nothing is the silent-failure shape the ACL
		// endpoint was filed about.
		writeError(w, http.StatusNotFound, "not found\n")
		return
	}
	h.patchACL(w, r, sid)
}

// injectOrWake models POST /sessions/{sid}/inject and .../wake.
//
// Two things here are not decoration.
//
// AN INJECT DOES NOT OPEN A CLOSED GATE (v1.11.0, core-agent#878).
// Through 1.10.0 it did, implicitly, and this mock published a wake
// frame unconditionally to match. That shim is gone upstream — the
// grounds were that "callers carry an identity, not a species" — so a
// message sent to a held session now queues behind the gate and the
// loop stays parked. Publishing a wake here regardless would model the
// old backend, and the SPA would be developed against a world where
// typing rescues a parked session. It does not. Only /resume does,
// which is the whole reason #70 stopped being deferrable.
//
// The response envelope is v1.10.0's. `woke` is reported on both paths
// and never omitted: false is the informative value, so a key that
// vanishes exactly when it says something is a key clients read wrong.
// `prompt_id` (#840) is omitted rather than empty, because there is no
// informative empty id and a caller has to handle its absence anyway.
func (h *mockHandler) injectOrWake(w http.ResponseWriter, r *http.Request, sid, endpoint string) {
	var req struct {
		Message string `json:"message"`
		Prompt  string `json:"prompt"`
		Target  string `json:"target"`
		// Pointer for the same reason core-agent's is: the distinction
		// that matters is "said nothing" vs. "said false".
		Wake *bool `json:"wake"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	drainBody(r)

	if endpoint == "wake" && req.Target != "" {
		writeError(w, http.StatusNotImplemented,
			"wake: per-subagent target is not yet implemented; omit 'target' to wake the session\n")
		return
	}
	text := req.Message
	if endpoint == "wake" {
		text = req.Prompt
	} else if text == "" {
		writeError(w, http.StatusBadRequest, "inject: message is required\n")
		return
	}

	// A bare wake queues nothing, so it names no prompt.
	promptID := ""
	if text != "" {
		promptID = h.nextPromptID()
	}

	gate := h.gates.get(sid)
	// `woke` answers for the delivery the caller asked for. A closed
	// gate is not a "no" to that question — upstream's flag reports the
	// requested disposition, and the gate is what decides whether the
	// loop acts on it.
	woke := req.Wake == nil || *req.Wake
	if woke && !gate.paused {
		// The loop actually runs. Since v1.7.0 the agent says so on the
		// stream, and publishing it here is what lets a consumer be
		// tested against a wake it caused — there is no other way to
		// provoke one from outside.
		next := gate
		next.turnInFlight = true
		h.gates.set(sid, next)
		h.hub.publish(sid, wakeFrame(time.Now()))
	}

	out := map[string]any{"session": sid, "woke": woke}
	if endpoint == "wake" {
		out = map[string]any{"woken": sid, "prompt": req.Prompt}
	} else {
		out["injected"] = req.Message
	}
	if promptID != "" {
		out["prompt_id"] = promptID
	}
	writeJSON(w, http.StatusOK, out)
}

// setTitle models POST /sessions/{sid}/title (v1.10.0, core-agent#808).
//
// The `title` key is required and a pointer upstream, because "" and
// omitted are different instructions: "" clears the name and re-arms
// inference, omitted is a caller who typo'd the key and would
// otherwise get a silent 200. A mock that accepted both alike would
// make that 400 undiscoverable.
//
// It answers with the STORED title after normalization — the 60-rune
// cap is modelled, the decorative-quote strip is not, since one is
// enough to prove the echo is worth reading — and with
// `persisted: false`, which IS NOT AN ERROR. False is the norm: a
// session with no durable ACL row has nowhere to write, and the rename
// is live for as long as the process is. A client that treats it as a
// failure will report every successful rename as broken.
func (h *mockHandler) setTitle(w http.ResponseWriter, r *http.Request, sid string) {
	var req struct {
		Title *string `json:"title"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	drainBody(r)
	if req.Title == nil {
		writeError(w, http.StatusBadRequest,
			`title: title is required (send {"title":""} to clear it)`+"\n")
		return
	}
	stored := normalizeTitle(*req.Title)
	setMockSessionTitle(sid, stored)
	writeJSON(w, http.StatusOK, map[string]any{
		"session":   sid,
		"title":     stored,
		"persisted": false,
	})
}

// maxTitleRunes is core-agent's cap. Runes, not bytes: the point of the
// limit is how wide the name draws in a picker.
const maxTitleRunes = 60

func normalizeTitle(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > maxTitleRunes {
		s = strings.TrimSpace(string(r[:maxTitleRunes]))
	}
	return s
}

// stopSubagent models POST /sessions/{sid}/agents/{name}/stop at
// v1.12.0 semantics (core-agent#897).
//
// The change the mock exists to expose: `stopped` used to mean "the
// name is registered" and now means "THIS CALL is what halted it". A
// subagent that finished on its own answers 200 with `stopped: false`
// and the terminal `status`, where through 1.11.0 it answered true and
// told an operator they had stopped something that completed thirty
// seconds earlier. A client must read the 200 itself as "it is no
// longer running".
//
// 404 keeps its narrow trigger — a name the manager has never
// registered — and is NOT the answer for a finished subagent: that one
// existed, the operator aimed correctly, and there is nothing to
// retry.
func (h *mockHandler) stopSubagent(w http.ResponseWriter, sid, name string) {
	for _, known := range knownSubagentNames {
		if name != known {
			continue
		}
		// `implementer` is the mock's already-finished subagent, so both
		// branches of #897 are reachable without any setup. A mock that
		// only modelled the live one would leave the case the change was
		// filed about untested.
		if name == finishedSubagentName {
			writeJSON(w, http.StatusOK, map[string]any{
				"session": sid,
				"agent":   name,
				"stopped": false,
				"status":  "completed",
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"session": sid,
			"agent":   name,
			"stopped": true,
			"status":  "stopped",
		})
		return
	}
	writeError(w, http.StatusNotFound, "stop: no subagent named "+strconv.Quote(name)+"\n")
}

// whoami echoes back whoever the request resolved to. It is the only
// way the SPA can learn its own identity — nothing else on the wire
// carries it — so a mock that answered a constant here would make the
// browser's "is this mine?" question untestable.
func (h *mockHandler) whoami(w http.ResponseWriter, r *http.Request) {
	c := callerOf(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"identity": c.identity,
		"admin":    false,
		"source":   c.source,
		"proxy_by": "",
	})
}

func (h *mockHandler) peers(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"peers": []any{}})
}

func (h *mockHandler) agentCard(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"name":        "mast-web-mock",
		"description": "Standalone smoke backend for mast-web",
		"version":     "0.0.0-mock",
	})
}

func (h *mockHandler) preflight(w http.ResponseWriter, _ *http.Request) {
	for k, v := range corsHeaders() {
		w.Header().Set(k, v)
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── SSE ────────────────────────────────────────────────────────────

func (h *mockHandler) sseEvents(w http.ResponseWriter, r *http.Request) {
	fixture := r.URL.Query().Get("fixture")
	if fixture == "" {
		// No explicit fixture: give the demo sessions distinct
		// transcripts, everything else the server default.
		_, sid, _, _ := sessionSegments(r.URL.Path)
		if named, ok := sessionFixtures[sid]; ok {
			fixture = named
		} else {
			fixture = h.fixture
		}
	}
	frames, err := loadFixture(h.fixturesDir, fixture)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "load fixture "+fixture+": "+err.Error())
		return
	}
	_, sid, _, _ := sessionSegments(r.URL.Path)
	h.streamSSE(w, r, frames, sid)
}

// streamSSE flushes each frame + sleeps between them, then holds the
// stream open with periodic keep-alive comments so the SPA doesn't
// think we hung up. Nil frames = keep-alive-only stream (used by
// /perms/stream).
//
// A non-empty liveSID subscribes the stream to that session's fan-out,
// so frames a POST handler produces after the fixture is exhausted —
// `pause`, `wake` — arrive here. Pass "" for streams that shouldn't see
// them: /perms/stream is a different channel and duplicating session
// events onto it would be a lie about where they came from.
func (h *mockHandler) streamSSE(w http.ResponseWriter, r *http.Request, frames []frame, liveSID string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "server does not support streaming (no http.Flusher)")
		return
	}
	for k, v := range corsHeaders() {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// X-Accel-Buffering: no is respected by nginx / most reverse
	// proxies; without it, SSE gets buffered and the SPA sees frames
	// in bursts instead of streaming.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// Subscribe before replaying, not after: with a frame delay set the
	// fixture takes seconds to drain, and an operator pressing Stop in
	// that window would otherwise have their pause event dropped on the
	// floor. Queued frames land as soon as the replay finishes.
	var live <-chan frame
	if liveSID != "" {
		ch, unsubscribe := h.hub.subscribe(liveSID)
		defer unsubscribe()
		live = ch
	}

	ctx := r.Context()
	delay := time.Duration(h.frameDelayMs) * time.Millisecond
	for _, fr := range frames {
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", fr.Event, fr.Data); err != nil {
			return
		}
		flusher.Flush()
		if delay > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
		} else if ctx.Err() != nil {
			return
		}
	}

	// Live phase: keep-alives until the client disconnects, plus
	// anything a POST handler publishes for this session.
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case fr := <-live:
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", fr.Event, fr.Data); err != nil {
				return
			}
			flusher.Flush()
		case <-tick.C:
			if _, err := io.WriteString(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// ─── Framing helpers ────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, body any) {
	buf, _ := json.Marshal(body)
	for k, v := range corsHeaders() {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(buf)
}

func writeEmpty(w http.ResponseWriter, status int) {
	for k, v := range corsHeaders() {
		w.Header().Set(k, v)
	}
	w.WriteHeader(status)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	for k, v := range corsHeaders() {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, msg)
}

func corsHeaders() map[string]string {
	return map[string]string{
		"Access-Control-Allow-Origin":  "*",
		"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Attach-Token",
		"Access-Control-Max-Age":       "3600",
	}
}

func drainBody(r *http.Request) {
	if r.Body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, r.Body)
	_ = r.Body.Close()
}
