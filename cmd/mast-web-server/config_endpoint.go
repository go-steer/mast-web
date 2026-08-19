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

// GET /config — how the SPA learns what kind of deployment it is
// running in.
//
// Registered in every mode so the SPA has exactly one bootstrap path.
// mock and static answer with auth.mode "none", which is the signal to
// keep today's behavior: show the setup modal, collect an endpoint and
// a token, talk to the backend directly.
//
// Preferred over injecting a window.__CONFIG__ into index.html: that
// would make spaHandler stateful and fight its no-store header, and it
// would break the tarball / static-host deployment shape, where the SPA
// is served by something that is not this binary.

import (
	"encoding/json"
	"net/http"
)

const configPath = "/config"

type configResponse struct {
	Mode      string       `json:"mode"`
	APIPrefix string       `json:"api_prefix"`
	Auth      authResponse `json:"auth"`

	// MultiDaemon and Backends are the seam for the hosted multi-daemon
	// phase. Emitted now, always false/empty, so adding the backend
	// alias map later is additive rather than a wire break: the SPA can
	// already branch on them.
	MultiDaemon bool          `json:"multi_daemon"`
	Backends    []backendInfo `json:"backends"`
}

type authResponse struct {
	Mode          string `json:"mode"`
	Authenticated bool   `json:"authenticated"`
	Identity      string `json:"identity,omitempty"`
	LoginURL      string `json:"login_url,omitempty"`
	LogoutURL     string `json:"logout_url,omitempty"`
}

type backendInfo struct {
	Alias string `json:"alias"`
	Label string `json:"label,omitempty"`
}

// configHandler answers GET /config. It is exempt from withAuth (see
// isAuthExempt) because an unauthenticated SPA still needs to be able
// to discover *that* it is unauthenticated, and where to go about it.
func configHandler(cfg config, authn authenticator) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET /config")
			return
		}

		resp := configResponse{
			Mode:      cfg.mode,
			APIPrefix: cfg.apiPrefix,
			Auth:      authResponse{Mode: authn.Mode()},
			Backends:  []backendInfo{},
		}
		// In proxy mode the SPA talks to the API prefix; in mock mode it
		// talks to the origin root; in static mode the operator chooses.
		if cfg.mode != modeProxy {
			resp.APIPrefix = ""
		}

		identity, ok := authn.Identity(r)
		resp.Auth.Authenticated = ok
		resp.Auth.Identity = identity

		w.Header().Set("Content-Type", "application/json")
		// no-store, not no-cache: the body carries the caller's identity
		// and must never be reused across users by an intermediate.
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Vary", "Cookie, Authorization")
		if r.Method == http.MethodHead {
			return
		}
		_ = json.NewEncoder(w).Encode(resp)
	})
}
