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
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// The mock held against the producer's own captures (testdata/upstream,
// copied from core-agent's pkg/attach/testdata/conformance). See the
// README there for why: a mock that agrees only with itself is how the
// v0.5 walkthrough found a mock that had never run a turn.

func upstreamCapture(t *testing.T, name string) map[string]any {
	t.Helper()
	buf, err := os.ReadFile(filepath.Join("testdata", "upstream", name))
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(buf, &out); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return out
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// framesOf returns the data of every frame named event in a fixture.
func framesOf(t *testing.T, fixture, event string) []map[string]any {
	t.Helper()
	frames, err := loadFixture(repoFixturesDir(t), fixture)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, fr := range frames {
		if fr.Event != event {
			continue
		}
		var d map[string]any
		if err := json.Unmarshal(fr.Data, &d); err != nil {
			t.Fatal(err)
		}
		out = append(out, d)
	}
	return out
}

// The fixtures that claim to carry an upstream frame carry it verbatim.
func TestUpstream_FixturesCarryTheCapturesVerbatim(t *testing.T) {
	for _, tc := range []struct {
		fixture, event, capture string
	}{
		{"013-guardrail-trip-cut", "guardrail-trip", "guardrail-trip-cut-v1.19.0.json"},
		{"013-guardrail-trip-cut", "turn-error", "turn-error-v1.19.0.json"},
		{"014-guardrail-trip-boundary", "guardrail-trip", "guardrail-trip-boundary-v1.13.0.json"},
	} {
		got := framesOf(t, tc.fixture, tc.event)
		if len(got) != 1 {
			t.Fatalf("%s: want exactly one %s frame, got %d", tc.fixture, tc.event, len(got))
		}
		if want := upstreamCapture(t, tc.capture); !reflect.DeepEqual(got[0], want) {
			t.Errorf("%s's %s frame has drifted from upstream's %s\n got: %#v\nwant: %#v",
				tc.fixture, tc.event, tc.capture, got[0], want)
		}
	}
}

// What the mock publishes itself has upstream's keys — no invented
// field, none missing. Values differ (ids, reasons); shape must not.
func TestUpstream_MockPublishesTheCapturedShapes(t *testing.T) {
	srv := newMockServer(t)
	frames, closeStream := attached(t, srv, "smoke-session")
	defer closeStream()

	postJSON(t, srv, "/sessions/smoke-session/inject", `{"message":"go"}`)
	awaitFrame(t, frames, "wake")
	postJSON(t, srv, "/_mock/guardrail-trip", `{"session":"smoke-session","halts_session":false}`)

	trip := awaitFrame(t, frames, "guardrail-trip")
	if got, want := keysOf(trip.Data), keysOf(upstreamCapture(t, "guardrail-trip-cut-v1.19.0.json")); !reflect.DeepEqual(got, want) {
		t.Errorf("guardrail-trip keys %v, upstream %v", got, want)
	}
	cancel := awaitFrame(t, frames, "turn-error")
	if got, want := keysOf(cancel.Data), keysOf(upstreamCapture(t, "turn-error-v1.19.0.json")); !reflect.DeepEqual(got, want) {
		t.Errorf("turn-error keys %v, upstream %v", got, want)
	}
	if cancel.Data["kind"] != "canceled" || cancel.Data["code"] != "CANCELED" || cancel.Data["retryable"] != false {
		t.Errorf("the cut's canceled differs from upstream's in value: %#v", cancel.Data)
	}
}

func TestUpstream_DowngradedRespondHasTheCapturedShape(t *testing.T) {
	srv := newMockServer(t)
	id := raiseOne(t, srv)
	resp := asCaller(t, http.MethodPost, srv.URL+"/sessions/smoke-session/perms/respond", mockDefaultCaller,
		strings.NewReader(`{"id":"`+id+`","decision":"allow-always"}`))
	defer resp.Body.Close()
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if g, want := keysOf(got), keysOf(upstreamCapture(t, "rest-perms-respond-v2.json")); !reflect.DeepEqual(g, want) {
		t.Errorf("respond keys %v, upstream %v", g, want)
	}
}
