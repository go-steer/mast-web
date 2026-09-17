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
	"strconv"
	"sync"
	"time"
)

// The mock's permission surface: the prompt stream, the response, and
// the approval log the two write into.
//
// Until now /perms answered `{}` and /perms/respond answered `{}`, and
// the prompt stream never produced a prompt — so the whole permission
// path was a channel the SPA opened and nothing ever came down. That
// made v1.10.0's attribution (core-agent#830) untestable in the only
// way that matters: `by` on a history row and `approver` on the
// respond 200 are both OMITTED when the daemon verified no identity,
// and a mock that could not answer both ways would let a client ship
// the one mistake the field exists to prevent — filling the blank in
// with whoever is looking at the screen.
//
// So the log here is attributed from the CALLER, exactly as upstream
// attributes it from its own caller-resolution verdict rather than
// from anything the client sends. Anonymous in, unattributed out. A
// spec can be either by setting the mock_caller cookie (see
// mock_acl.go), and the two answers are visibly different.

// permsHubKey namespaces the prompt stream's fan-out. The perms stream
// is a SECOND channel — session events must not appear on it and its
// prompts must not appear on the event stream — so it subscribes under
// a key no session frame is ever published to. Same hub, different
// topic, which is cheaper than a second hub and keeps the drop-rather-
// than-block behaviour a slow reader needs.
func permsHubKey(sid string) string { return "perms:" + sid }

// mockApproval is one row of the per-session approval log, in the
// shape GET /sessions/{sid}/perms reports (pkg/attach/state.go
// ApprovalInfo).
//
// `by` is a string and its zero value is meaningful: it is the daemon
// saying it could not attribute this decision, which is a different
// statement from any name it could have put there. It is rendered as
// an omitted key, never as "" or "unknown" — a client that sees a
// present-but-empty field has been told something false about what the
// daemon knows.
type mockApproval struct {
	tool     string
	key      string
	decision string
	by       string
	at       time.Time
}

func (a mockApproval) wire() map[string]any {
	out := map[string]any{
		"tool":     a.tool,
		"decision": a.decision,
		"at":       a.at.UTC().Format(time.RFC3339Nano),
	}
	if a.key != "" {
		out["key"] = a.key
	}
	if a.by != "" {
		out["by"] = a.by
	}
	return out
}

// mockPermsLog holds the approvals a running server has accumulated,
// keyed by session. Seeded rows are not stored here — they are
// computed per read so their timestamps stay relative to now, which is
// what makes the log readable as "this session" rather than as a
// museum of whenever the process started.
type mockPermsLog struct {
	mu   sync.Mutex
	rows map[string][]mockApproval
	seq  int
	// tools remembers what each raised prompt asked about, so the log
	// row the answer produces names the tool the operator was actually
	// looking at. A log that said "tool" for every row would render
	// fine and mean nothing.
	//
	// Hangs off the handler rather than the package, so a fresh server
	// is a fresh log — the package-level ACL overlay next door is the
	// counter-example, and it needs an explicit reset in every test
	// because of it.
	tools map[string]string
}

func (l *mockPermsLog) append(sid string, a mockApproval) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.rows == nil {
		l.rows = make(map[string][]mockApproval)
	}
	l.rows[sid] = append(l.rows[sid], a)
}

func (l *mockPermsLog) get(sid string) []mockApproval {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]mockApproval(nil), l.rows[sid]...)
}

func (l *mockPermsLog) reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rows = nil
	l.tools = nil
	l.seq = 0
}

// rememberTool records what a raised prompt was about; toolFor reads
// it back at respond time. An id nobody raised (a spec answering a
// prompt it invented) falls back to a placeholder rather than an empty
// tool name, which would render as a blank row.
func (l *mockPermsLog) rememberTool(id, tool string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.tools == nil {
		l.tools = make(map[string]string)
	}
	l.tools[id] = tool
}

func (l *mockPermsLog) toolFor(id string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if s := l.tools[id]; s != "" {
		return s
	}
	return "tool"
}

// nextFrameID hands out ids the way a daemon does — opaque, unique,
// and correlating a prompt frame with the respond that answers it.
// Distinct from mockHandler.nextPromptID, which mints INBOX ids for
// inject/wake: those name a queued message, these name a question.
func (l *mockPermsLog) nextFrameID() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seq++
	return "perms-" + strconv.Itoa(l.seq)
}

// seededApprovals are the two rows every session starts with, and they
// are two because the pair is the whole lesson: one decision the
// daemon could attribute and one it could not. A log where every row
// had a name would let a renderer that assumes attribution pass, and
// an empty log would let one that never renders it pass.
func seededApprovals(now time.Time) []mockApproval {
	return []mockApproval{
		{
			tool:     "bash_exec",
			key:      "git push",
			decision: "allow-session-tool",
			by:       mockDefaultCaller,
			at:       now.Add(-12 * time.Minute),
		},
		{
			// Answered through a listener that verified nobody. The row
			// is real, the decision stuck, and there is no one to ask
			// about it — which is exactly what the operator needs to be
			// able to see.
			tool:     "fs_write",
			key:      "/etc/hosts",
			decision: "allow-once",
			at:       now.Add(-4 * time.Minute),
		},
	}
}

// getPerms backs GET /sessions/{sid}/perms — mode, the standing
// patterns, and the approval log (pkg/attach/state.go PermsInfo).
func (h *mockHandler) getPerms(w http.ResponseWriter, sid string) {
	now := time.Now()
	rows := append(seededApprovals(now), h.perms.get(sid)...)
	wire := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		wire = append(wire, r.wire())
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"mode":      "ask",
		"allow":     []string{"fs_read", "gke_*"},
		"deny":      []string{"bash_exec rm -rf *"},
		"approvals": wire,
	})
}

// permsRespond backs POST /sessions/{sid}/perms/respond.
//
// Two v1.10.0 behaviours, both modelled because both are load-bearing:
//
//   - The 200 echoes `approver` — what the server RECORDED, so a
//     client can tell "attributed to the human who clicked" from
//     "accepted, and the audit line will be anonymous" without a
//     second call to /whoami. Omitted when nobody was verified.
//   - A request that carries its own `approver` is CHECKED against the
//     verified caller, not believed: 400 on a mismatch. The field can
//     never widen what gets recorded, so the only thing it can do is
//     disagree — and a client whose idea of who is approving differs
//     from the server's wants to hear about it rather than have its
//     version quietly dropped.
func (h *mockHandler) permsRespond(w http.ResponseWriter, r *http.Request, sid string) {
	var req struct {
		ID       string `json:"id"`
		Decision string `json:"decision"`
		Approver string `json:"approver"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		drainBody(r)
		writeError(w, http.StatusBadRequest, "perms/respond: malformed JSON body\n")
		return
	}
	drainBody(r)
	if req.ID == "" || req.Decision == "" {
		writeError(w, http.StatusBadRequest, "perms/respond: id and decision are required\n")
		return
	}
	c := callerOf(r)
	if req.Approver != "" && req.Approver != c.identity {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"perms/respond: approver %s does not match the verified caller %s; omit the field and the server attributes the decision itself\n",
			strconv.Quote(req.Approver), strconv.Quote(c.identity)))
		return
	}
	h.perms.append(sid, mockApproval{
		tool:     h.perms.toolFor(req.ID),
		decision: req.Decision,
		by:       c.identity,
		at:       time.Now(),
	})
	out := map[string]any{"acknowledged": true}
	if !c.anonymous() {
		out["approver"] = c.identity
	}
	writeJSON(w, http.StatusOK, out)
}

// raisePrompt backs POST /_mock/perms-prompt — test-only, like the
// gate reset. Body: {session, tool?, detail?, kind?}.
//
// A real daemon raises a prompt when the agent reaches for something
// gated, which is not a thing a fixture replay can cause: the mock has
// no permission checker because it has no tools. So the prompt is
// injected from outside, the same way a turn is. This is what makes
// the inline permission card — and the attribution on it — reachable
// from a spec and from the manual walkthrough at all.
func (h *mockHandler) raisePrompt(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Session string `json:"session"`
		Tool    string `json:"tool"`
		Detail  string `json:"detail"`
		Kind    string `json:"kind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		drainBody(r)
		writeError(w, http.StatusBadRequest, "perms-prompt: malformed JSON body\n")
		return
	}
	drainBody(r)
	if req.Session == "" {
		writeError(w, http.StatusBadRequest, "perms-prompt: session is required\n")
		return
	}
	tool := req.Tool
	if tool == "" {
		tool = "bash_exec"
	}
	kind := req.Kind
	if kind == "" {
		kind = "bash"
	}
	detail := req.Detail
	if detail == "" {
		detail = "rm -rf ./build"
	}
	id := h.perms.nextFrameID()
	h.perms.rememberTool(id, tool)
	payload := map[string]any{
		"id":     id,
		"kind":   kind,
		"tool":   tool,
		"detail": detail,
		"at":     time.Now().UTC().Format(time.RFC3339Nano),
	}
	buf, _ := json.Marshal(payload)
	h.hub.publish(permsHubKey(req.Session), frame{Event: "prompt", Data: buf})
	writeJSON(w, http.StatusOK, map[string]any{"raised": true, "id": id})
}

// resetPermsLog backs DELETE /_mock/perms-log. The log is per-process
// state a spec can leak into the next one, so it clears the same way
// the pause gates and the share state do.
func (h *mockHandler) resetPermsLog(w http.ResponseWriter, _ *http.Request) {
	h.perms.reset()
	writeEmpty(w, http.StatusNoContent)
}
