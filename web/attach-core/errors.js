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

// attach-core/errors — typed errors the attach client raises so
// consumers can distinguish terminal states from transient ones.
//
// Loaded ahead of client.js in index.html; client.js reads
// window.AttachCoreErrors.PermanentStreamError.

window.AttachCoreErrors = (function () {
  'use strict';

  // Thrown by client._get / client._post on HTTP 404/401/403 — statuses
  // that mean the session is gone or auth is revoked. Consumers should
  // stop the reconnect loop and surface a terminal banner rather than
  // retrying. Mirrors the pattern in core-agent/internal/attachclient/
  // status_error.go so mast-web behaves identically to coretuiremote.
  class PermanentStreamError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'PermanentStreamError';
      this.status = status;
    }
    static isPermanentStatus(status) {
      return status === 401 || status === 403 || status === 404;
    }
  }

  // Thrown by client._post (and other session-scoped write calls) on
  // HTTP 503 — the daemon is draining for shutdown and is refusing to
  // accept messages it can't guarantee delivery of (queued messages
  // live in memory only). This is transient and self-resolving once
  // the daemon restarts; consumers should surface a "retry shortly"
  // message rather than a generic error, and may use
  // retryAfterSeconds (from the Retry-After header) to time a retry.
  // See core-agent pkg/attach/handlers.go (routeSessionDrainGated).
  class BackendDrainingError extends Error {
    constructor(message, retryAfterSeconds) {
      super(message);
      this.name = 'BackendDrainingError';
      this.retryAfterSeconds =
        typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds
          : null;
    }
  }

  return { PermanentStreamError, BackendDrainingError };
})();
