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
const wireProtocolVersion = "1.7.0"

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
// anything ever exercises. sessionShapeIsCanonical in mock_test.go is
// the guard.

// mockSession is the canned session the SPA auto-selects on connect.
// Kept minimal — just enough to open an SSE stream. Always first in
// mockSessions so single-session consumers (smoke tests, index.html's
// auto-select) keep landing on it.
var mockSession = map[string]any{
	"app":             "mast-web-mock",
	"user":            "smoke@example.com",
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
		"user":            "smoke@example.com",
		"sessionID":       "ops-triage",
		"has_event_log":   true,
		"status":          "active",
		"last_touched_at": "2026-07-20T11:52:00Z",
		"title":           "Paging alert on checkout-api",
	},
	{
		"app":             "core-agent",
		"user":            "smoke@example.com",
		"sessionID":       "docs-writer",
		"has_event_log":   true,
		"status":          "idle",
		"last_touched_at": "2026-07-20T09:14:00Z",
		"title":           "Rewrite the attach quickstart",
	},
	{
		"app":             "mast",
		"user":            "smoke@example.com",
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
	stubSubagentsCatalog = map[string]any{
		"subagents": []map[string]any{
			{
				"name":        "researcher",
				"description": "Research + summarize",
				"model":       "mock-model-1.5",
				"modes":       []string{"sync", "async"},
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

	// Test-only introspection. Not part of the attach protocol —
	// the underscore marks it as belonging to the mock, not to
	// anything a real backend serves.
	mux.HandleFunc("GET /_mock/turn-requests", h.turnRequests)
	mux.HandleFunc("DELETE /_mock/turn-requests", h.turnRequests)
	// The pause gate is the mock's only persistent state, so it's also
	// the only thing a spec can leak into the next one. Let them clear
	// it rather than restart the server between cases.
	mux.HandleFunc("DELETE /_mock/pause-gates", h.resetGates)

	// Session-agnostic endpoints.
	mux.HandleFunc("GET /whoami", h.whoami)
	mux.HandleFunc("GET /peers", h.peers)
	mux.HandleFunc("GET /.well-known/agent-card.json", h.agentCard)

	// CORS preflight — scoped to endpoints the SPA sends non-simple
	// requests to. Can't use a bare `OPTIONS /` because Go's ServeMux
	// treats method+catchall combinations as ambiguous vs. any
	// method-less pattern like /healthz. Scope narrowly instead.
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
		"pause", "resume":
		return true
	}
	return false
}

// ─── Handlers ────────────────────────────────────────────────────────

func (h *mockHandler) listSessions(w http.ResponseWriter, _ *http.Request) {
	out := make([]any, 0, len(mockSessions))
	for _, s := range mockSessions {
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

func (h *mockHandler) createSession(w http.ResponseWriter, r *http.Request) {
	drainBody(r)
	writeJSON(w, http.StatusCreated, map[string]any{
		"app":       mockSession["app"],
		"user":      mockSession["user"],
		"sessionID": "smoke-session-2",
		"url":       "http://" + r.Host + "/sessions/" + mockSession["app"].(string) + "/smoke-session-2",
	})
}

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
func (h *mockHandler) statusFor(sid string) map[string]any {
	out := make(map[string]any, len(stubStatus)+4)
	for k, v := range stubStatus {
		out[k] = v
	}
	gate := h.gates.get(sid)
	out["paused"] = gate.paused
	if gate.paused {
		out["turn_state"] = "paused"
		out["paused_since"] = gate.since.UTC().Format(time.RFC3339Nano)
		out["pause_reason"] = gate.reason
		if gate.interrupted {
			out["interrupted"] = true
		}
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
// slash/<name> (returns a markdown _render response), and a {}
// fallthrough for inject / wake / perms/allow / perms/deny etc.
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
	drainBody(r)
	switch tail[0] {
	case "inject", "wake":
		// Both wake the loop, and since v1.7.0 the agent says so on the
		// stream. Publishing it here is what lets a consumer be tested
		// against a wake it caused — there is no other way to provoke
		// one from outside.
		h.hub.publish(sid, wakeFrame(time.Now()))
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
	// Everything else (inject / wake / perms/allow / perms/deny /
	// perms/respond / pricing/* / reload) — accept as no-op.
	writeJSON(w, http.StatusOK, map[string]any{})
}

func (h *mockHandler) whoami(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"identity": "smoke@example.com",
		"admin":    false,
		"source":   "mock",
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
		"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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
