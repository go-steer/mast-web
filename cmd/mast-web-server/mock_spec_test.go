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
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The drift guard.
//
// Every other test in this package asks whether the mock behaves the
// way the mock is written to behave. That is a closed loop, and it is
// the loop that let the attach protocol move three minor versions
// without anything going red: the client was wrong, the mock was wrong
// in the same direction, and the tests agreed with both.
//
// These tests ask a different question — whether the mock agrees with
// the spec — so that falling behind is itself a failure rather than a
// thing someone has to notice.

// repoFixturesDir is the real fixture directory the mock serves in
// dev and in the smoke suite, as opposed to the throwaway one
// newMockServer builds.
func repoFixturesDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "web", "attach-core", "conformance", "fixtures"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("fixtures dir: %v", err)
	}
	return dir
}

// capabilitiesFrame is the shape of the first frame of every stream.
type capabilitiesFrame struct {
	ProtocolVersion string          `json:"protocol_version"`
	EventTypes      []string        `json:"event_types"`
	Server          string          `json:"server"`
	Features        map[string]bool `json:"features"`
}

// loadCapabilities reads a fixture's leading capabilities frame.
func loadCapabilities(t *testing.T, dir, name string) capabilitiesFrame {
	t.Helper()
	frames, err := loadFixture(dir, name)
	if err != nil {
		t.Fatalf("load %s: %v", name, err)
	}
	if len(frames) == 0 {
		t.Fatalf("%s: empty fixture", name)
	}
	if frames[0].Event != "capabilities" {
		t.Fatalf("%s: first frame is %q, want capabilities (spec §2)", name, frames[0].Event)
	}
	var caps capabilitiesFrame
	if err := json.Unmarshal(frames[0].Data, &caps); err != nil {
		t.Fatalf("%s: decode capabilities: %v", name, err)
	}
	return caps
}

// TestMock_DefaultFixtureMatchesSpec is the check that would have made
// the 1.4.0 → 1.7.0 drift visible the week it happened.
//
// The mock's default fixture is the world every smoke test and every
// `npm run dev` session sees. If it advertises a protocol version older
// than the one we claim to model, the SPA is being developed and tested
// against a backend that no longer exists.
func TestMock_DefaultFixtureMatchesSpec(t *testing.T) {
	dir := repoFixturesDir(t)
	caps := loadCapabilities(t, dir, defaultMockFixture)

	if caps.ProtocolVersion != wireProtocolVersion {
		t.Errorf("default fixture advertises protocol %s, but this mock models %s — "+
			"bump the fixture's capabilities frame, or lower wireProtocolVersion if we really are behind",
			caps.ProtocolVersion, wireProtocolVersion)
	}

	// Every event the mock can put on the wire has to be declared, or a
	// consumer gating on event_types will correctly ignore a frame we
	// went to the trouble of sending.
	for _, ev := range mockPublishedEvents {
		if !slices.Contains(caps.EventTypes, ev) {
			t.Errorf("mock publishes %q frames but the default fixture doesn't declare it in event_types", ev)
		}
	}

	// No reverse check: `event_types` is the backend's repertoire, not
	// an inventory of this stream. A happy turn declaring `turn-error`
	// and never erroring is correct, and a consumer needs the
	// declaration to know the control is worth wiring at all.
}

// TestMock_AdvertisedFeaturesHaveEndpoints pins the other half of the
// capabilities contract: `features` is how a client decides which
// controls to offer, so a flag the mock sets true had better lead
// somewhere. Advertising a control that 404s is worse than not
// advertising it — the UI renders a button that cannot work.
func TestMock_AdvertisedFeaturesHaveEndpoints(t *testing.T) {
	dir := repoFixturesDir(t)
	caps := loadCapabilities(t, dir, defaultMockFixture)

	// feature flag → the session endpoints it promises.
	routes := map[string][]string{
		"interrupt":  {"interrupt"},
		"pause":      {"pause", "resume"},
		"guardrails": {"guardrails"},
	}
	for flag, endpoints := range routes {
		if !caps.Features[flag] {
			continue
		}
		for _, ep := range endpoints {
			if !isKnownSessionEndpoint(ep) {
				t.Errorf("features.%s is advertised but /sessions/{sid}/%s isn't routed", flag, ep)
			}
		}
	}

	// The gate is the reason this mock keeps state at all; if the flag
	// ever goes away, #68 becomes untestable again.
	if !caps.Features["pause"] {
		t.Error("features.pause is not advertised — the v1.5.0 gate is what makes #68 reproducible")
	}
}

// TestMock_FixturesDeclareTheEventsTheyEmit is the internal-consistency
// check, applied to every fixture rather than just the default. A
// fixture that emits a frame its own capabilities frame doesn't declare
// is describing a backend that cannot exist, and a consumer that gates
// on event_types would be right to drop the frame.
//
// Fixtures deliberately pinned to older protocol versions are fine —
// back-compat coverage is the point of some of them. They just have to
// be self-consistent.
func TestMock_FixturesDeclareTheEventsTheyEmit(t *testing.T) {
	dir := repoFixturesDir(t)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var checked int
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), ".jsonl")
		if !ok {
			continue
		}
		checked++
		caps := loadCapabilities(t, dir, name)
		for _, ev := range fixtureEventNames(t, dir, name) {
			if !slices.Contains(caps.EventTypes, ev) {
				t.Errorf("%s: emits a %q frame that its capabilities frame doesn't declare", name, ev)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no fixtures found — the guard is checking nothing")
	}
}

// fixtureEventNames returns the distinct SSE event names a fixture
// emits, in first-seen order.
func fixtureEventNames(t *testing.T, dir, name string) []string {
	t.Helper()
	frames, err := loadFixture(dir, name)
	if err != nil {
		t.Fatalf("load %s: %v", name, err)
	}
	var out []string
	for _, fr := range frames {
		if !slices.Contains(out, fr.Event) {
			out = append(out, fr.Event)
		}
	}
	return out
}

// TestMock_ServesTheCurrentProtocolOverHTTP closes the loop end to end:
// the guard above reads the fixture off disk, this one reads what a
// client actually receives. They can disagree if the serving path ever
// starts rewriting frames.
func TestMock_ServesTheCurrentProtocolOverHTTP(t *testing.T) {
	h, err := newMockHandler(config{
		fixturesDir: repoFixturesDir(t),
		fixture:     defaultMockFixture,
	})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	registerMockRoutes(mux, h)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	frames, closeStream := openStream(t, srv, "smoke-session")
	defer closeStream()

	fr := awaitFrame(t, frames, "capabilities")
	if got := fr.Data["protocol_version"]; got != wireProtocolVersion {
		t.Fatalf("client sees protocol %v, want %s", got, wireProtocolVersion)
	}
}
