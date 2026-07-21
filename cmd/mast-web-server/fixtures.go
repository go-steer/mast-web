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
	"fmt"
	"os"
	"path/filepath"
)

// frame is one SSE event from a conformance fixture. Kept as a raw
// json.RawMessage on data so we don't re-serialize / re-parse — the
// mock streams the byte payload verbatim to preserve any structure
// the fixture author put in.
type frame struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

// loadFixture reads a JSONL fixture from dir. name may include or
// omit the .jsonl extension. On missing fixture, falls back to
// 001-happy-turn with a stderr note rather than 500-ing — the smoke
// UI is nicer to debug when it always renders something. If even the
// fallback is missing, returns the underlying error.
func loadFixture(dir, name string) ([]frame, error) {
	stem := name
	if len(stem) > 6 && stem[len(stem)-6:] == ".jsonl" {
		stem = stem[:len(stem)-6]
	}
	path := filepath.Join(dir, stem+".jsonl")
	frames, err := readFixture(path)
	if err == nil {
		return frames, nil
	}
	if os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "mock: fixture %q not found; falling back to 001-happy-turn\n", stem)
		fallback := filepath.Join(dir, "001-happy-turn.jsonl")
		return readFixture(fallback)
	}
	return nil, err
}

func readFixture(path string) ([]frame, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []frame
	scanner := bufio.NewScanner(f)
	// Some fixture lines are large (full capabilities frame in
	// 005-*). Bump the scanner buffer above the 64KB default.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	line := 0
	for scanner.Scan() {
		line++
		text := scanner.Bytes()
		if len(text) == 0 {
			continue
		}
		var fr frame
		if err := json.Unmarshal(text, &fr); err != nil {
			return nil, fmt.Errorf("%s line %d: %w", path, line, err)
		}
		out = append(out, fr)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return out, nil
}
