#!/usr/bin/env bash
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

# Shared helpers for dev/tools/* scripts.
#
# Source this from each tool with:
#   . "$(dirname "$0")/common.sh"
#
# Provides:
#   repo_root        — absolute path to the git working tree root
#   ensure_node_deps — runs `npm install --silent` if node_modules is missing
#   run_step         — run a command + print a "▸ name" header (for ci aggregator)

set -euo pipefail

repo_root() {
  git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel
}

# ensure_node_deps: bootstrap node_modules if missing. Assumes npm is on
# PATH (see package.json engines for the supported Node version).
ensure_node_deps() {
  local root
  root="$(repo_root)"
  if [[ -d "$root/node_modules" ]]; then
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "ensure_node_deps: npm not found on PATH — install Node $(jq -r .engines.node "$root/package.json" 2>/dev/null || echo 'per package.json')" >&2
    return 1
  fi
  echo "▸ installing node dev dependencies (one-time)…" >&2
  (cd "$root" && npm install --silent)
}

# run_step <label> <command...>
#
# Runs the command and prints a tidy header. Used by the ci aggregator
# so each check has a visible boundary in the output. Exit code is
# propagated.
run_step() {
  local label="$1"; shift
  printf '\n\033[1m▸ %s\033[0m\n' "$label"
  "$@"
}
