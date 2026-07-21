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

// Playwright config for the automated smoke tests (v0.3.0 PR 6).
//
// Test scenarios live under smoke/ and drive the SPA in headless
// chromium against the standalone mock backend (cmd/mast-web-server
// --mode=mock). One test per conformance fixture; assertions run
// against the rendered DOM to catch regressions the vitest unit
// tests can't see.
//
// Chromium only for v0.3.0 — mast-web is deliberately not doing
// anything browser-fingerprinty, so cross-browser coverage adds cost
// without commensurate value. Firefox / Safari can layer on later.

import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.SMOKE_PORT || '7799';
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './smoke',
  // Fail fast in CI; give devs room to iterate locally.
  fullyParallel: false, // one server, avoid stepping on each other
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // one server = one worker; no parallelism benefit anyway
  reporter: process.env.CI ? [['github'], ['list']] : 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Boot the mock backend + serve the SPA before the tests run.
  // Mock frame-delay is intentionally short so fixtures play through
  // quickly without lengthening CI wall time.
  webServer: {
    command: `go run ./cmd/mast-web-server --mode=mock --web-dir=web --listen=:${PORT} --frame-delay-ms=10`,
    url: `${BASE_URL}/sessions`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
