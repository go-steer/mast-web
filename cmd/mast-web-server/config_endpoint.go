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
// Behind auth, with the API paths, not open with the health probes.
// What it hands out — the API prefix, the mode, the auth mode name — is
// a map of the deployment for anyone who asks, and nobody who needs it
// is anonymous: the SPA can only be running if its document request
// already cleared auth. See withAuth.
//
// Preferred over injecting a window.__CONFIG__ into index.html: that
// would make spaHandler stateful and fight its no-store header, and it
// would break the tarball / static-host deployment shape, where the SPA
// is served by something that is not this binary.

import (
	"encoding/json"
	"net/http"
	"strings"
)

const configPath = "/config"

// identityVaryHeaders lists every request header that can change this
// response's identity field, for Vary.
func identityVaryHeaders(cfg config) []string {
	v := []string{"Cookie", "Authorization"}
	switch cfg.authMode {
	case authModeProxyHeader:
		if cfg.authHeader != "" {
			v = append(v, cfg.authHeader)
		}
	case authModeIAPJWT:
		v = append(v, iapAssertionHeader)
	}
	return v
}

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

// configHandler answers GET /config. withAuth gates it like an API
// path, so in an authenticating deployment this only ever runs for a
// verified caller. It still reports honestly when it doesn't have one —
// mock and static reach it with auth.mode "none", and a handler that
// lies about identity when reached by an unexpected route is a worse
// failure than one that says "not you".
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
		// Vary is belt to no-store's braces, so it has to name the header
		// the identity actually came from — listing only Cookie and
		// Authorization would describe a cache key that ignores the input
		// that changes the body.
		w.Header().Set("Vary", strings.Join(identityVaryHeaders(cfg), ", "))
		if r.Method == http.MethodHead {
			return
		}
		_ = json.NewEncoder(w).Encode(resp)
	})
}
