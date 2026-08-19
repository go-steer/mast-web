# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Convenience entrypoints. Real logic lives in dev/tools/.
# Same scripts run locally and in CI — "green local = green remote."

.PHONY: dev smoke e2e build test lint format ci clean docs-serve

# Local development server (serves web/ on :8000).
dev:
	./dev/tools/dev

# Standalone smoke test — SPA + mock backend, no real agent needed.
# Boots dev/tools/dev on :8000 and dev/tools/mock-backend on :7778;
# operator connects the SPA to the mock URL to render a canned
# conversation from the conformance fixtures. Ctrl-C tears down both.
# See dev/tools/smoke for fixture selection + env overrides.
smoke:
	./dev/tools/smoke

# Hosted multi-user end-to-end check against a REAL core-agent. Not
# part of `make ci` — it needs an agent binary CI doesn't have. Point
# it at one with CORE_AGENT_BIN=/path/to/core-agent, and add
# KEEP_RUNNING=1 to leave a browsable two-user rig up afterwards.
e2e:
	./dev/tools/e2e-real-backend

# Build the distributable static bundle into ./dist/.
build:
	./dev/tools/build

# Run JS unit tests.
test:
	./dev/tools/test-unit

# Run all linters (JS + CSS + HTML).
lint:
	./dev/tools/lint-js
	./dev/tools/lint-css
	./dev/tools/verify-html

# Verify formatting (prettier --check).
format:
	./dev/tools/verify-format

# Run every presubmit in sequence — identical to what CI runs.
ci:
	./dev/tools/ci

# Local Hugo preview at http://localhost:1313/mast-web/.
docs-serve:
	cd docs/site && hugo server

# Remove build output.
clean:
	rm -rf dist/ web/dist/ docs/site/public/ docs/site/resources/_gen/
