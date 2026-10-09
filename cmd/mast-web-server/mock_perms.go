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
	"slices"
	"strconv"
	"strings"
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
	tool          string
	key           string
	decision      string
	by            string
	approverModel string // 1.18.0: the approver model allowed it, no person
	at            time.Time
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
	if a.approverModel != "" {
		out["approver_model"] = a.approverModel
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
	// prompts remembers every raised prompt: what it asked about, which
	// session it belongs to, whether the approver model escalated it,
	// and how it stands.
	//
	// The tool and key are what the log row an answer produces names. A
	// log that said "tool" for every row would render fine and mean
	// nothing, and "allowed bash_exec" without the key is not something
	// an operator reviewing the log can act on (#126).
	//
	// The status is what makes 1.14.0's answers reachable: 404 for an id
	// already answered or never issued, and 410 for a prompt that was
	// there and is gone — its timeout ran out, or its turn was cut. The
	// two 410s say different things and are worded verbatim from
	// upstream (pkg/attach/prompter.go).
	//
	// Hangs off the handler rather than the package, so a fresh server
	// is a fresh log — the package-level ACL overlay next door is the
	// counter-example, and it needs an explicit reset in every test
	// because of it.
	prompts map[string]mockPrompt
	// modes is each session's permission mode once POST /perms/mode
	// (1.16.0) has set it; an absent entry is the configured "ask".
	modes map[string]string
}

// mockPrompt is one raised permission prompt.
type mockPrompt struct {
	sid       string
	tool      string
	key       string
	escalated bool   // the auto-mode approver passed it to a person (1.18.0)
	status    string // pending | answered | expired | canceled
}

// The two 410 bodies, verbatim from core-agent pkg/attach/prompter.go
// (ErrPromptExpired, ErrPromptCanceled). Different facts, different
// fixes: answer faster or raise approval_timeout, versus look at why the
// turn ended.
const (
	promptExpiredBody  = "attach: approval arrived after the prompt expired; the action was not taken"
	promptCanceledBody = "attach: the prompt's turn ended before the approval arrived; the action was not taken"
)

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
	l.prompts = nil
	l.modes = nil
	l.seq = 0
}

// remember records a raised prompt as pending.
func (l *mockPermsLog) remember(id string, p mockPrompt) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.prompts == nil {
		l.prompts = make(map[string]mockPrompt)
	}
	p.status = "pending"
	l.prompts[id] = p
}

// prompt reads one back; ok is false for an id this mock never issued.
func (l *mockPermsLog) prompt(id string) (mockPrompt, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	p, ok := l.prompts[id]
	return p, ok
}

// settle moves a prompt out of pending. Returns false if it was not
// pending, so two answers racing one prompt can't both be applied.
func (l *mockPermsLog) settle(id, status string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	p, ok := l.prompts[id]
	if !ok || p.status != "pending" {
		return false
	}
	p.status = status
	l.prompts[id] = p
	return true
}

// cancelPending ends every pending prompt on a session because its turn
// was cut — an operator's interrupt or a guardrail's. An answer that
// arrives afterwards gets the second 410: the action was not taken, and
// answering faster would not have helped.
func (l *mockPermsLog) cancelPending(sid string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for id, p := range l.prompts {
		if p.sid == sid && p.status == "pending" {
			p.status = "canceled"
			l.prompts[id] = p
		}
	}
}

func (l *mockPermsLog) mode(sid string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if m := l.modes[sid]; m != "" {
		return m
	}
	return "ask"
}

func (l *mockPermsLog) setMode(sid, mode string) (previous string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	previous = l.modes[sid]
	if previous == "" {
		previous = "ask"
	}
	if l.modes == nil {
		l.modes = make(map[string]string)
	}
	l.modes[sid] = mode
	return previous
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
	rows := seededApprovals(now)
	// In auto mode the approver model allows some calls with no person
	// involved, and the log names the model (`approver_model`) with no
	// `by` (1.18.0). Only a session in auto has such a row.
	if h.perms.mode(sid) == "auto" {
		rows = append(rows, mockApproval{
			tool:          "fs_read",
			key:           "docs/runbook.md",
			decision:      "allow-once",
			approverModel: "claude-sonnet-5-5",
			at:            now.Add(-2 * time.Minute),
		})
	}
	rows = append(rows, h.perms.get(sid)...)
	wire := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		wire = append(wire, r.wire())
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"mode":      h.perms.mode(sid),
		"allow":     []string{"fs_read", "gke_*"},
		"deny":      []string{"bash_exec rm -rf *"},
		"approvals": wire,
		// 1.18.0: the modes POST /perms/mode will accept for this
		// session, in the chip's order, so a client never offers one it
		// would be refused. `auto` is in it because the mock models a
		// session with an approver configured.
		"settable_modes": mockSettableModes,
	})
}

// mockSettableModes is what this session's gate will take. `allow` is
// never settable over HTTP (it lives in .agents/config.json only).
var mockSettableModes = []string{"ask", "auto", "acceptEdits", "plan", "yolo"}

// maxDenyReasonBytes is upstream's MaxDenyReasonBytes (1.15.0).
const maxDenyReasonBytes = 500

// setPermMode backs POST /sessions/{sid}/perms/mode (1.16.0,
// core-agent#1168). SessionAdmin-gated, and a caller the ACL refuses
// gets the same 404 as a session that doesn't exist — so a client that
// knows the negotiated version can read a 404 as "not yours". A mode
// outside settable_modes is a 400 and changes nothing.
func (h *mockHandler) setPermMode(w http.ResponseWriter, r *http.Request, sid string) {
	var req struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		drainBody(r)
		writeError(w, http.StatusBadRequest, "perms/mode: malformed JSON body\n")
		return
	}
	drainBody(r)
	c := callerOf(r)
	if !aclFor(sid, c).canAdmin(c.identity) {
		writeError(w, http.StatusNotFound, "session not found\n")
		return
	}
	if !slices.Contains(mockSettableModes, req.Mode) {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"perms/mode: %s is not a mode this session can be set to (settable: %s)\n",
			strconv.Quote(req.Mode), strings.Join(mockSettableModes, ", ")))
		return
	}
	previous := h.perms.setMode(sid, req.Mode)
	writeJSON(w, http.StatusOK, map[string]any{"previous": previous, "mode": req.Mode})
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
		Reason   string `json:"reason"`
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
	// 1.15.0: a reason rides only with a deny, collapses to one line,
	// and is capped. Either 400 leaves the prompt pending, so the
	// operator can fix the request and send it again.
	reason := strings.Join(strings.Fields(req.Reason), " ")
	if reason != "" && req.Decision != "deny" {
		writeError(w, http.StatusBadRequest,
			"perms/respond: a reason is accepted only with a deny; instructions for an approved call belong in a steer\n")
		return
	}
	if len(reason) > maxDenyReasonBytes {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(
			"perms/respond: reason is %d bytes, over the %d-byte limit\n", len(reason), maxDenyReasonBytes))
		return
	}

	// 1.14.0: where the prompt stands decides the status.
	p, known := h.perms.prompt(req.ID)
	switch {
	case !known || p.status == "answered":
		writeError(w, http.StatusNotFound,
			"perms/respond: no pending prompt with that id: already answered, or never issued here\n")
		return
	case p.status == "expired":
		writeError(w, http.StatusGone, promptExpiredBody+"\n")
		return
	case p.status == "canceled":
		writeError(w, http.StatusGone, promptCanceledBody+"\n")
		return
	}

	// What gets APPLIED, which is not always what was sent. 1.18.0: any
	// allow on a prompt the approver escalated is applied once. 1.17.0:
	// an allow-always from anyone but a daemon admin is applied for the
	// session — and the mock configures no admins, which upstream says
	// downgrades every HTTP always.
	applied, downgraded := req.Decision, false
	switch {
	case p.escalated && req.Decision != "deny" && req.Decision != "allow-once":
		applied, downgraded = "allow-once", true
	case req.Decision == "allow-always":
		applied, downgraded = "allow-session", true
	}
	if !h.perms.settle(req.ID, "answered") {
		writeError(w, http.StatusNotFound,
			"perms/respond: no pending prompt with that id: already answered, or never issued here\n")
		return
	}
	h.perms.append(sid, mockApproval{
		tool:     p.tool,
		key:      p.key,
		decision: applied,
		by:       c.identity,
		at:       time.Now(),
	})
	out := map[string]any{"acknowledged": true, "decision": applied}
	if downgraded {
		out["downgraded"] = true // omitted when false (1.17.0)
	}
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
		// 1.18.0: an auto-mode prompt the approver model passed to a
		// person. The reason is model output, and a client must quote it
		// as the approver's words, never as the daemon's.
		ApproverModel  string `json:"approver_model"`
		ApproverReason string `json:"approver_reason"`
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
	h.perms.remember(id, mockPrompt{
		sid:       req.Session,
		tool:      tool,
		key:       detail,
		escalated: req.ApproverModel != "",
	})
	payload := map[string]any{
		"id":     id,
		"kind":   kind,
		"tool":   tool,
		"detail": detail,
		"at":     time.Now().UTC().Format(time.RFC3339Nano),
	}
	if req.ApproverModel != "" {
		payload["approver_model"] = req.ApproverModel
		if req.ApproverReason != "" {
			payload["approver_reason"] = req.ApproverReason
		}
	}
	buf, _ := json.Marshal(payload)
	h.hub.publish(permsHubKey(req.Session), frame{Event: "prompt", Data: buf})
	writeJSON(w, http.StatusOK, map[string]any{"raised": true, "id": id})
}

// endPrompt backs POST /_mock/perms-prompt-end — test-only. Ends a
// pending prompt without an answer, as `expired` (approval_timeout ran
// out) or `canceled` (its turn was cut), so an answer sent afterwards
// gets the matching 410 (1.14.0). A cut turn cancels its prompts on its
// own (interrupt, guardrail trip); this is for the timeout, and for a
// test that wants the 410 without a turn.
func (h *mockHandler) endPrompt(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID  string `json:"id"`
		Why string `json:"why"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		drainBody(r)
		writeError(w, http.StatusBadRequest, "perms-prompt-end: malformed JSON body\n")
		return
	}
	drainBody(r)
	if req.Why != "expired" && req.Why != "canceled" {
		writeError(w, http.StatusBadRequest, `perms-prompt-end: why must be "expired" or "canceled"`+"\n")
		return
	}
	if !h.perms.settle(req.ID, req.Why) {
		writeError(w, http.StatusNotFound, "perms-prompt-end: no pending prompt with that id\n")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ended": req.ID, "why": req.Why})
}

// resetPermsLog backs DELETE /_mock/perms-log. The log is per-process
// state a spec can leak into the next one, so it clears the same way
// the pause gates and the share state do.
func (h *mockHandler) resetPermsLog(w http.ResponseWriter, _ *http.Request) {
	h.perms.reset()
	writeEmpty(w, http.StatusNoContent)
}
