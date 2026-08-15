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
	"time"
)

// mockHandler serves the fake attach-protocol endpoints the SPA hits
// during connect + normal operation. Fed from JSONL conformance
// fixtures under cfg.fixturesDir. Same shape the Python mock served,
// re-implemented in Go so the whole repo is one language and the
// production binary covers dev use cases too.
type mockHandler struct {
	fixturesDir  string
	fixture      string
	frameDelayMs int
}

// mockSession is the canned session returned from GET /sessions.
// Kept minimal — just enough for the SPA to auto-select it and open
// an SSE stream.
var mockSession = map[string]any{
	"app_name":        "mast-web-mock",
	"user_id":         "smoke@example.com",
	"session_id":      "smoke-session",
	"has_event_log":   true,
	"status":          "active",
	"last_touched_at": "2026-07-20T12:00:00Z",
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
	stubTools = map[string]any{
		"tools": []map[string]any{
			{"name": "fs_read", "description": "Read files", "source": "builtin", "gate_state": "allowed"},
			{"name": "fs_write", "description": "Write files", "source": "builtin", "gate_state": "prompted"},
			{"name": "bash_exec", "description": "Run shell commands", "source": "builtin", "gate_state": "prompted"},
			{"name": "kube_get", "description": "kubectl get", "source": "other", "gate_state": "allowed"},
			{"name": "kube_apply", "description": "kubectl apply", "source": "other", "gate_state": "prompted"},
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
		"skills", "mcp", "pricing", "perms", "reload", "slash":
		return true
	}
	return false
}

// ─── Handlers ────────────────────────────────────────────────────────

func (h *mockHandler) listSessions(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"sessions": []any{mockSession}})
}

func (h *mockHandler) createSession(w http.ResponseWriter, r *http.Request) {
	drainBody(r)
	writeJSON(w, http.StatusCreated, map[string]any{
		"app":       mockSession["app_name"],
		"user":      mockSession["user_id"],
		"sessionID": "smoke-session-2",
		"url":       "http://" + r.Host + "/sessions/" + mockSession["app_name"].(string) + "/smoke-session-2",
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
			h.streamSSE(w, r, nil)
			return
		}
		// /perms (no /stream) — return {} for the perms read.
		writeJSON(w, http.StatusOK, map[string]any{})
	case "status":
		writeJSON(w, http.StatusOK, stubStatus)
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
// against /sessions/... . Handles interrupt (with X-Interrupted
// header), slash/<name> (returns a markdown _render response), and a
// {} fallthrough for inject / wake / perms/allow / perms/deny etc.
func (h *mockHandler) sessionPost(w http.ResponseWriter, r *http.Request) {
	drainBody(r)
	_, _, tail, ok := sessionSegments(r.URL.Path)
	if !ok || len(tail) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	switch tail[0] {
	case "interrupt":
		// /interrupt returns X-Interrupted: nothing-in-flight so the
		// Stop button flashes without an error toast.
		for k, v := range corsHeaders() {
			w.Header().Set(k, v)
		}
		w.Header().Set("X-Interrupted", "nothing-in-flight")
		w.WriteHeader(http.StatusOK)
		return
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
		fixture = h.fixture
	}
	frames, err := loadFixture(h.fixturesDir, fixture)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "load fixture "+fixture+": "+err.Error())
		return
	}
	h.streamSSE(w, r, frames)
}

// streamSSE flushes each frame + sleeps between them, then holds the
// stream open with periodic keep-alive comments so the SPA doesn't
// think we hung up. Nil frames = keep-alive-only stream (used by
// /perms/stream).
func (h *mockHandler) streamSSE(w http.ResponseWriter, r *http.Request, frames []frame) {
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

	// Keep-alive loop until the client disconnects.
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
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
