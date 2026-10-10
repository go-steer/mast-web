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
	"slices"
	"strings"
	"testing"
	"time"
)

// producerAgentKeys is GET /sessions/{sid}/agents' row shape, from
// core-agent's docs/attach-http.md at protocol 1.20.0 — the keys a row
// may carry and the ones it always does. There is no vendored upstream
// capture for this route (testdata/upstream), so this list is the drift
// guard: the mock answered with the configured roster's shape for two
// releases, and nothing noticed (#106, #136).
var (
	producerAgentKeys = []string{
		"id", "name", "status", "started_at", "parent_session_id",
		"last_report", "next_wake_at", "wake_detail",
	}
	producerAgentRequired = []string{"id", "name", "status", "started_at"}
	producerAgentStatuses = []string{"running", "completed", "failed", "stopped", "deferred"}
)

func agentRows(t *testing.T, out map[string]any) []map[string]any {
	t.Helper()
	raw, ok := out["agents"].([]any)
	if !ok {
		t.Fatalf("GET agents: want {agents: [...]}, got %v", out)
	}
	rows := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		rows = append(rows, r.(map[string]any))
	}
	return rows
}

// A fresh session runs nothing: the roster is an empty array, not absent.
func TestMockRoster_EmptyByDefault(t *testing.T) {
	srv := newMockServer(t)
	rows := agentRows(t, getJSON(t, srv, "/sessions/smoke-session/agents"))
	if len(rows) != 0 {
		t.Fatalf("want an empty roster, got %v", rows)
	}
}

func TestMockRoster_RowsHaveTheProducersShape(t *testing.T) {
	srv := newMockServer(t)
	postJSON(t, srv, "/_mock/subagent", `{"session":"smoke-session","name":"researcher","last_report":"read 3 files\nthen more"}`)
	postJSON(t, srv, "/_mock/subagent", `{"session":"smoke-session","name":"watcher","status":"deferred","wake_in_s":240,"wake_detail":"poll the build"}`)
	postJSON(t, srv, "/_mock/subagent", `{"session":"smoke-session","name":"implementer","status":"completed"}`)

	rows := agentRows(t, getJSON(t, srv, "/sessions/smoke-session/agents"))
	if len(rows) != 3 {
		t.Fatalf("want 3 rows, got %v", rows)
	}
	for _, row := range rows {
		for k := range row {
			if !slices.Contains(producerAgentKeys, k) {
				t.Errorf("row %v: key %q is not in the producer's shape", row["name"], k)
			}
		}
		for _, k := range producerAgentRequired {
			if _, ok := row[k]; !ok {
				t.Errorf("row %v: missing required key %q", row["name"], k)
			}
		}
		if !slices.Contains(producerAgentStatuses, row["status"].(string)) {
			t.Errorf("row %v: status %q is not one the producer sends", row["name"], row["status"])
		}
		if _, err := time.Parse(time.RFC3339Nano, row["started_at"].(string)); err != nil {
			t.Errorf("row %v: started_at: %v", row["name"], err)
		}
	}
	if rows[0]["name"] != "researcher" || rows[0]["status"] != "running" {
		t.Errorf("status defaults to running, in start order: %v", rows[0])
	}
	if rows[0]["last_report"] != "read 3 files\nthen more" {
		t.Errorf("last_report: %v", rows[0]["last_report"])
	}
	if _, ok := rows[2]["last_report"]; ok {
		t.Errorf("an empty last_report is omitted, not sent empty: %v", rows[2])
	}
	wake, err := time.Parse(time.RFC3339Nano, rows[1]["next_wake_at"].(string))
	if err != nil || time.Until(wake) < 200*time.Second {
		t.Errorf("next_wake_at should be ~240 s out: %v (%v)", rows[1]["next_wake_at"], err)
	}
	if rows[1]["wake_detail"] != "poll the build" {
		t.Errorf("wake_detail: %v", rows[1]["wake_detail"])
	}
	// Rosters are per session.
	if other := agentRows(t, getJSON(t, srv, "/sessions/repo-indexer/agents")); len(other) != 0 {
		t.Errorf("another session's roster leaked: %v", other)
	}
}

// An update keeps the id and started_at; it is the same subagent.
func TestMockRoster_UpsertKeepsIdentity(t *testing.T) {
	srv := newMockServer(t)
	first := postJSON(t, srv, "/_mock/subagent", `{"session":"smoke-session","name":"researcher","started_ago_s":125}`)
	second := postJSON(t, srv, "/_mock/subagent", `{"session":"smoke-session","name":"researcher","status":"failed"}`)
	if first["id"] != second["id"] || first["started_at"] != second["started_at"] {
		t.Errorf("update changed identity: %v → %v", first, second)
	}
	started, _ := time.Parse(time.RFC3339Nano, first["started_at"].(string))
	if ago := time.Since(started); ago < 120*time.Second || ago > 130*time.Second {
		t.Errorf("started_ago_s: started %v ago", ago)
	}
	if rows := agentRows(t, getJSON(t, srv, "/sessions/smoke-session/agents")); len(rows) != 1 || rows[0]["status"] != "failed" {
		t.Errorf("want one failed row, got %v", rows)
	}
}

// Stopping a running roster row stops it; stopping a finished one does not.
func TestMockRoster_StopFollowsTheRoster(t *testing.T) {
	srv := newMockServer(t)
	postJSON(t, srv, "/_mock/subagent", `{"session":"smoke-session","name":"scout","wake_in_s":30}`)
	postJSON(t, srv, "/_mock/subagent", `{"session":"smoke-session","name":"done","status":"completed"}`)

	out := postJSON(t, srv, "/sessions/smoke-session/agents/scout/stop", `{}`)
	if out["stopped"] != true || out["status"] != "stopped" {
		t.Errorf("stop a running row: %v", out)
	}
	out = postJSON(t, srv, "/sessions/smoke-session/agents/done/stop", `{}`)
	if out["stopped"] != false || out["status"] != "completed" {
		t.Errorf("stop a finished row: %v", out)
	}
	rows := agentRows(t, getJSON(t, srv, "/sessions/smoke-session/agents"))
	if rows[0]["status"] != "stopped" {
		t.Errorf("the roster should show scout stopped: %v", rows[0])
	}
	if _, ok := rows[0]["next_wake_at"]; ok {
		t.Errorf("a stopped subagent has no wake: %v", rows[0])
	}
}

func TestMockRoster_ResetAndValidation(t *testing.T) {
	srv := newMockServer(t)
	postJSON(t, srv, "/_mock/subagent", `{"session":"smoke-session","name":"researcher"}`)
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/_mock/subagents", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /_mock/subagents: %d", resp.StatusCode)
	}
	if rows := agentRows(t, getJSON(t, srv, "/sessions/smoke-session/agents")); len(rows) != 0 {
		t.Errorf("reset left rows: %v", rows)
	}
	for _, body := range []string{`{"session":"smoke-session"}`, `{"name":"x"}`, `not json`, `{"session":"s","name":"x","next_wake_at":"soon"}`} {
		resp, err := http.Post(srv.URL+"/_mock/subagent", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("POST %s: want 400, got %d", body, resp.StatusCode)
		}
	}
}
