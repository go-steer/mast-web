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

.PHONY: dev build test lint format ci clean docs-serve

# Local development server (serves web/ on :8000).
dev:
	./dev/tools/dev

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
