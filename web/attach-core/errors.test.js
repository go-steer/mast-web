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

// Unit tests for web/attach-core/errors.js.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcErrors = readFileSync(join(here, 'errors.js'), 'utf8');

function loadErrors() {
  new Function('window', srcErrors)(globalThis);
  return globalThis.AttachCoreErrors;
}

describe('AttachCoreErrors', () => {
  let AttachCoreErrors;
  beforeEach(() => {
    delete globalThis.AttachCoreErrors;
    AttachCoreErrors = loadErrors();
  });

  it('exports PermanentStreamError', () => {
    expect(AttachCoreErrors.PermanentStreamError).toBeDefined();
  });

  it('exports BackendDrainingError', () => {
    expect(AttachCoreErrors.BackendDrainingError).toBeDefined();
  });

  describe('PermanentStreamError', () => {
    it('is an Error with name, message, status', () => {
      const err = new AttachCoreErrors.PermanentStreamError('gone', 404);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('PermanentStreamError');
      expect(err.message).toBe('gone');
      expect(err.status).toBe(404);
    });

    it('classifies 401/403/404 as permanent, others transient', () => {
      const P = AttachCoreErrors.PermanentStreamError;
      // Permanent (from core-agent/internal/attachclient/status_error.go):
      // - 404 masks not-found + ACL-revoked
      // - 401 = token revoked/expired
      // - 403 = ACL revoked mid-attach
      expect(P.isPermanentStatus(401)).toBe(true);
      expect(P.isPermanentStatus(403)).toBe(true);
      expect(P.isPermanentStatus(404)).toBe(true);
      // Transient — keep retrying:
      expect(P.isPermanentStatus(200)).toBe(false);
      expect(P.isPermanentStatus(400)).toBe(false);
      expect(P.isPermanentStatus(408)).toBe(false); // request timeout
      expect(P.isPermanentStatus(429)).toBe(false); // rate limited
      expect(P.isPermanentStatus(500)).toBe(false);
      expect(P.isPermanentStatus(502)).toBe(false);
      expect(P.isPermanentStatus(503)).toBe(false);
      expect(P.isPermanentStatus(504)).toBe(false);
    });
  });

  describe('BackendDrainingError', () => {
    it('is an Error with name, message, retryAfterSeconds', () => {
      const err = new AttachCoreErrors.BackendDrainingError('draining', 5);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('BackendDrainingError');
      expect(err.message).toBe('draining');
      expect(err.retryAfterSeconds).toBe(5);
    });

    it('normalizes a missing/non-numeric retryAfterSeconds to null', () => {
      expect(new AttachCoreErrors.BackendDrainingError('draining').retryAfterSeconds).toBeNull();
      expect(
        new AttachCoreErrors.BackendDrainingError('draining', NaN).retryAfterSeconds
      ).toBeNull();
    });
  });
});
