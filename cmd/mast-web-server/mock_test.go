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
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newMockServer builds a fresh mock backend against a fixtures dir
// pre-populated with two fixtures — a happy turn and a cost-ceiling.
// Returns the httptest.Server + a cleanup that shuts it down. Frame
// delay is 0 so tests aren't slow.
func newMockServer(t *testing.T) *httptest.Server {
	t.Helper()
	fixDir := t.TempDir()
	happy := `{"event":"capabilities","data":{"protocol_version":"1.4.0","event_types":["capabilities"],"server":"test"}}
{"event":"status-update","data":{"model":"m","turn_state":"idle"}}
{"event":"turn-complete","data":{"prompt_id":"p1","model":"m","tokens_in":1,"tokens_out":1,"latency_ms":10}}
`
	writeFile(t, fixDir, "001-happy-turn.jsonl", happy)
	ceiling := `{"event":"turn-error","data":{"kind":"cost_ceiling","message":"blocked","retryable":false}}
`
	writeFile(t, fixDir, "002-cost-ceiling.jsonl", ceiling)

	cfg := config{
		mode:         modeMock,
		fixturesDir:  fixDir,
		fixture:      "001-happy-turn",
		frameDelayMs: 0,
		apiPrefix:    "/attach",
	}
	handler, err := buildMux(cfg)
	if err != nil {
		t.Fatalf("buildMux: %v", err)
	}
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

func writeFile(t *testing.T, dir, name, contents string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

// ─── Endpoints ───────────────────────────────────────────────────────

func TestMock_ListSessions(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Get(srv.URL + "/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"session_id": "smoke-session"`) &&
		!strings.Contains(string(body), `"session_id":"smoke-session"`) {
		t.Fatalf("want smoke-session in response, got %q", string(body))
	}
}

func TestMock_CreateSession(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Post(srv.URL+"/sessions", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("want 201, got %d", resp.StatusCode)
	}
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["sessionID"] != "smoke-session-2" {
		t.Fatalf("want smoke-session-2, got %v", got["sessionID"])
	}
}

func TestMock_DeleteSession_GuardsDefault(t *testing.T) {
	srv := newMockServer(t)
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/sessions/mast-web-mock/default", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403 on default, got %d", resp.StatusCode)
	}
}

func TestMock_DeleteSession_OK(t *testing.T) {
	srv := newMockServer(t)
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/sessions/mast-web-mock/smoke-session", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("want 204, got %d", resp.StatusCode)
	}
}

func TestMock_SessionReadStubs(t *testing.T) {
	srv := newMockServer(t)
	for _, ep := range []string{"status", "tools", "agents", "usage"} {
		resp, err := http.Get(srv.URL + "/sessions/smoke-session/" + ep)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: want 200, got %d", ep, resp.StatusCode)
		}
	}
}

func TestMock_UnknownSessionReadReturnsEmptyObject(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Get(srv.URL + "/sessions/smoke-session/memory")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 for unknown session read, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if strings.TrimSpace(string(body)) != "{}" {
		t.Fatalf("want {} for unknown session read, got %q", string(body))
	}
}

func TestMock_Whoami(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Get(srv.URL + "/whoami")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["identity"] != "smoke@example.com" {
		t.Fatalf("want smoke@example.com, got %v", got["identity"])
	}
	// proxy_by is present (empty string), matching v1.4.0 shape.
	if _, ok := got["proxy_by"]; !ok {
		t.Fatal("want proxy_by field in response")
	}
}

func TestMock_Peers(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Get(srv.URL + "/peers")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"peers"`) {
		t.Fatalf("want peers key, got %q", string(body))
	}
}

func TestMock_AgentCard(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Get(srv.URL + "/.well-known/agent-card.json")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "mast-web-mock") {
		t.Fatalf("want mast-web-mock, got %q", string(body))
	}
}

func TestMock_Interrupt_ReturnsHeader(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Post(srv.URL+"/sessions/smoke-session/interrupt", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("X-Interrupted") != "nothing-in-flight" {
		t.Fatalf("want X-Interrupted header, got %q", resp.Header.Get("X-Interrupted"))
	}
}

func TestMock_SessionSlash_ReturnsRenderableBody(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Post(srv.URL+"/sessions/smoke-session/slash/compact", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["_render"] != "markdown" {
		t.Fatalf("want _render=markdown, got %v", got["_render"])
	}
}

// ─── SSE ────────────────────────────────────────────────────────────

func TestMock_SSE_StreamsFixture(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Get(srv.URL + "/sessions/smoke-session/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("want text/event-stream, got %q", ct)
	}

	// Read the first three frame boundaries + confirm they match the
	// fixture we wrote in newMockServer.
	scanner := bufio.NewScanner(resp.Body)
	var got []string
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event: ") {
			got = append(got, strings.TrimPrefix(line, "event: "))
		}
		if len(got) >= 3 {
			break
		}
	}
	want := []string{"capabilities", "status-update", "turn-complete"}
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("want events %v, got %v", want, got)
	}
}

func TestMock_SSE_QueryOverridesFixture(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Get(srv.URL + "/sessions/smoke-session/events?fixture=002-cost-ceiling")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event: ") {
			if got := strings.TrimPrefix(line, "event: "); got != "turn-error" {
				t.Fatalf("want turn-error (from 002 fixture), got %q", got)
			}
			return
		}
	}
	t.Fatal("no event frame in response")
}

func TestMock_SSE_MissingFixtureFallsBack(t *testing.T) {
	srv := newMockServer(t)
	// bogus fixture name → mock logs a warning and falls back to
	// 001-happy-turn (which we did write in the tmpdir).
	resp, err := http.Get(srv.URL + "/sessions/smoke-session/events?fixture=nonexistent")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 (fallback), got %d", resp.StatusCode)
	}
}

// ─── CORS ────────────────────────────────────────────────────────────

func TestMock_CORSHeaders(t *testing.T) {
	srv := newMockServer(t)
	resp, err := http.Get(srv.URL + "/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("want *, got %q", resp.Header.Get("Access-Control-Allow-Origin"))
	}
}

func TestMock_OPTIONSPreflight(t *testing.T) {
	srv := newMockServer(t)
	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/sessions", nil)
	req.Header.Set("Origin", "http://example")
	req.Header.Set("Access-Control-Request-Method", "POST")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("want 204 on OPTIONS, got %d", resp.StatusCode)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("want CORS headers on OPTIONS response")
	}
}

// ─── Health ─────────────────────────────────────────────────────────

func TestMock_HealthProbes(t *testing.T) {
	srv := newMockServer(t)
	for _, path := range []string{"/healthz", "/readyz"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: want 200, got %d", path, resp.StatusCode)
		}
		resp.Body.Close()
	}
}
