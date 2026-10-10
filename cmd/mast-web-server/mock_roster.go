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
	"fmt"
	"net/http"
	"sync"
	"time"
)

// The live subagent roster, GET /sessions/{sid}/agents (v0.7 #138).
//
// Until v0.7 the mock answered this route with a constant shaped like the
// CONFIGURED roster — {name, description}, which is what /subagents
// returns — and two releases read that and concluded the live roster had
// no status, so a running count could not be shown truthfully (#106).
// The producer's rows have always carried it (core-agent attach-http.md):
//
//	{"agents": [{"id", "name", "status", "started_at", "parent_session_id"?,
//	             "last_report"?, "next_wake_at"?, "wake_detail"?}]}
//
// with status running | completed | failed | stopped | deferred, and since
// protocol 1.20.0 (#1283) a `last_report` that fills in while a subagent
// runs and `next_wake_at` / `wake_detail` while it sleeps on a scheduled
// wake. TestMockRoster_RowsHaveTheProducersShape pins that key set, which
// is the guard whose absence let the mistake stand.
//
// A fresh session's roster is EMPTY: nothing is running, which is what a
// real daemon says before anything is spawned, and a default "running"
// row would put a subagent on every session in every spec. Specs make
// subagents with POST /_mock/subagent.

// mockAgentRow is one live subagent.
type mockAgentRow struct {
	id         string
	name       string
	status     string
	startedAt  time.Time
	lastReport string
	nextWakeAt time.Time
	wakeDetail string
}

func (a mockAgentRow) wire() map[string]any {
	out := map[string]any{
		"id":         a.id,
		"name":       a.name,
		"status":     a.status,
		"started_at": a.startedAt.UTC().Format(time.RFC3339Nano),
	}
	// Omitted, not empty, when there is nothing to say — absence is
	// "nothing we can see", and the producer omits them the same way.
	if a.lastReport != "" {
		out["last_report"] = a.lastReport
	}
	if !a.nextWakeAt.IsZero() {
		out["next_wake_at"] = a.nextWakeAt.UTC().Format(time.RFC3339Nano)
		if a.wakeDetail != "" {
			out["wake_detail"] = a.wakeDetail
		}
	}
	return out
}

// mockRoster holds each session's live subagents, in start order.
type mockRoster struct {
	mu  sync.Mutex
	m   map[string][]mockAgentRow
	ids int
}

func (r *mockRoster) rows(sid string) []mockAgentRow {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]mockAgentRow(nil), r.m[sid]...)
}

// find returns sid's row by name.
func (r *mockRoster) find(sid, name string) (mockAgentRow, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, a := range r.m[sid] {
		if a.name == name {
			return a, true
		}
	}
	return mockAgentRow{}, false
}

// upsert replaces the row with the same name, or appends a new one.
func (r *mockRoster) upsert(sid string, row mockAgentRow) mockAgentRow {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.m == nil {
		r.m = make(map[string][]mockAgentRow)
	}
	for i, a := range r.m[sid] {
		if a.name == row.name {
			if row.id == "" {
				row.id = a.id
			}
			r.m[sid][i] = row
			return row
		}
	}
	if row.id == "" {
		r.ids++
		row.id = fmt.Sprintf("mock-agent-%d", r.ids)
	}
	r.m[sid] = append(r.m[sid], row)
	return row
}

func (r *mockRoster) setStatus(sid, name, status string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, a := range r.m[sid] {
		if a.name == name {
			a.status = status
			a.nextWakeAt = time.Time{}
			a.wakeDetail = ""
			r.m[sid][i] = a
			return
		}
	}
}

func (r *mockRoster) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.m = nil
}

func (h *mockHandler) rosterWire(sid string) map[string]any {
	rows := h.roster.rows(sid)
	out := make([]map[string]any, 0, len(rows))
	for _, a := range rows {
		out = append(out, a.wire())
	}
	return map[string]any{"agents": out}
}

// upsertSubagent backs POST /_mock/subagent — test-only. Creates or
// updates one live roster row, so a spec can make a subagent start,
// report, sleep on a scheduled wake, and finish:
//
//	{ "session": "smoke-session",           required
//	  "name": "researcher",                 required
//	  "status": "running",                  default running
//	  "started_at": "<RFC 3339>",           default now (kept on update)
//	  "started_ago_s": 125,                 alternative: started N seconds ago
//	  "last_report": "…",                   1.20.0
//	  "next_wake_at": "<RFC 3339>",         1.20.0; or "wake_in_s": 240
//	  "wake_detail": "…" }                  1.20.0
func (h *mockHandler) upsertSubagent(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Session     string  `json:"session"`
		Name        string  `json:"name"`
		Status      string  `json:"status"`
		StartedAt   string  `json:"started_at"`
		StartedAgoS float64 `json:"started_ago_s"`
		LastReport  string  `json:"last_report"`
		NextWakeAt  string  `json:"next_wake_at"`
		WakeInS     float64 `json:"wake_in_s"`
		WakeDetail  string  `json:"wake_detail"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		drainBody(r)
		writeError(w, http.StatusBadRequest, "subagent: malformed JSON body\n")
		return
	}
	drainBody(r)
	if req.Session == "" || req.Name == "" {
		writeError(w, http.StatusBadRequest, "subagent: session and name are required\n")
		return
	}
	now := time.Now()
	row := mockAgentRow{name: req.Name, status: req.Status, lastReport: req.LastReport, wakeDetail: req.WakeDetail}
	if row.status == "" {
		row.status = "running"
	}
	prev, existed := h.roster.find(req.Session, req.Name)
	switch {
	case req.StartedAt != "":
		t, err := time.Parse(time.RFC3339Nano, req.StartedAt)
		if err != nil {
			writeError(w, http.StatusBadRequest, "subagent: started_at is not RFC 3339\n")
			return
		}
		row.startedAt = t
	case req.StartedAgoS > 0:
		row.startedAt = now.Add(-time.Duration(req.StartedAgoS * float64(time.Second)))
	case existed:
		row.startedAt = prev.startedAt
	default:
		row.startedAt = now
	}
	switch {
	case req.NextWakeAt != "":
		t, err := time.Parse(time.RFC3339Nano, req.NextWakeAt)
		if err != nil {
			writeError(w, http.StatusBadRequest, "subagent: next_wake_at is not RFC 3339\n")
			return
		}
		row.nextWakeAt = t
	case req.WakeInS > 0:
		row.nextWakeAt = now.Add(time.Duration(req.WakeInS * float64(time.Second)))
	}
	saved := h.roster.upsert(req.Session, row)
	writeJSON(w, http.StatusOK, saved.wire())
}

// resetRoster backs DELETE /_mock/subagents. Test-only.
func (h *mockHandler) resetRoster(w http.ResponseWriter, _ *http.Request) {
	h.roster.reset()
	writeEmpty(w, http.StatusNoContent)
}
