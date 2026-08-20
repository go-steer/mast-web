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
	"strings"
	"testing"
)

func getConfig(t *testing.T, cfg config, authn authenticator, mutate func(*http.Request)) (int, http.Header, configResponse) {
	t.Helper()
	r := httptest.NewRequest("GET", configPath, nil)
	if mutate != nil {
		mutate(r)
	}
	w := httptest.NewRecorder()
	configHandler(cfg, authn).ServeHTTP(w, r)

	var out configResponse
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode /config: %v (%q)", err, w.Body.String())
		}
	}
	return w.Code, w.Header(), out
}

func TestConfigEndpoint_VaryNamesTheIdentityHeader(t *testing.T) {
	// The body carries the caller's identity, so the cache key has to
	// name the header that identity came from. no-store is what actually
	// prevents cross-user reuse; a Vary that omits the deciding input is
	// still a wrong description of the response.
	cases := []struct {
		name string
		cfg  config
		want string
	}{
		{"proxy-header", config{mode: modeProxy, authMode: authModeProxyHeader, authHeader: "X-Forwarded-Email"}, "X-Forwarded-Email"},
		{"iap-jwt", config{mode: modeProxy, authMode: authModeIAPJWT}, iapAssertionHeader},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, hdr, _ := getConfig(t, tc.cfg, noAuth{}, nil)
			if got := hdr.Get("Vary"); !strings.Contains(got, tc.want) {
				t.Errorf("Vary = %q, want it to name %q", got, tc.want)
			}
			if got := hdr.Get("Cache-Control"); got != "no-store" {
				t.Errorf("Cache-Control = %q, want no-store", got)
			}
		})
	}
}

func TestConfigEndpoint_StaticModeReportsNoAuth(t *testing.T) {
	// static and mock must keep today's behavior: the SPA shows the
	// setup modal and talks to a backend of the operator's choosing.
	code, _, got := getConfig(t, config{mode: modeStatic, apiPrefix: "/attach"}, noAuth{}, nil)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	if got.Mode != modeStatic {
		t.Fatalf("mode = %q", got.Mode)
	}
	if got.Auth.Mode != authModeNone || !got.Auth.Authenticated {
		t.Fatalf("auth = %+v, want mode=none authenticated=true", got.Auth)
	}
	if got.APIPrefix != "" {
		t.Fatalf("api_prefix = %q, want empty outside proxy mode", got.APIPrefix)
	}
}

func TestConfigEndpoint_ProxyModeReportsPrefixAndIdentity(t *testing.T) {
	cfg := config{mode: modeProxy, apiPrefix: "/attach", authMode: authModeProxyHeader}
	code, _, got := getConfig(t, cfg, headerAuth{header: "X-Test-User"}, func(r *http.Request) {
		r.Header.Set("X-Test-User", "alice@example.com")
	})
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	if got.APIPrefix != "/attach" {
		t.Fatalf("api_prefix = %q", got.APIPrefix)
	}
	if got.Auth.Mode != authModeProxyHeader {
		t.Fatalf("auth.mode = %q", got.Auth.Mode)
	}
	if !got.Auth.Authenticated || got.Auth.Identity != "alice@example.com" {
		t.Fatalf("auth = %+v", got.Auth)
	}
}

func TestConfigEndpoint_ReportsUnauthenticatedWithout200Failing(t *testing.T) {
	// withAuth is what keeps anonymous callers away from this handler
	// (TestWithAuth_ConfigIsNotAnonymous); the handler itself is still
	// held to telling the truth about who is asking. Reached without an
	// identity — mock and static do exactly that, with auth.mode "none"
	// — it must say so rather than name someone.
	cfg := config{mode: modeProxy, apiPrefix: "/attach", authMode: authModeProxyHeader}
	code, _, got := getConfig(t, cfg, headerAuth{header: "X-Test-User"}, nil)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	if got.Auth.Authenticated {
		t.Fatal("want authenticated=false")
	}
	if got.Auth.Identity != "" {
		t.Fatalf("identity leaked: %q", got.Auth.Identity)
	}
}

func TestConfigEndpoint_IsNotCacheable(t *testing.T) {
	// The body names the caller. An intermediate reusing it across
	// users would be an identity mix-up.
	_, hdr, _ := getConfig(t, config{mode: modeProxy, apiPrefix: "/attach"}, noAuth{}, nil)
	if cc := hdr.Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}
}

func TestConfigEndpoint_ReservesMultiDaemonSeam(t *testing.T) {
	// Emitted now, always false/empty, so the later backend alias map
	// is an additive change rather than a wire break.
	_, _, got := getConfig(t, config{mode: modeProxy, apiPrefix: "/attach"}, noAuth{}, nil)
	if got.MultiDaemon {
		t.Fatal("multi_daemon should be false in this phase")
	}
	if got.Backends == nil {
		t.Fatal("backends should serialize as [] rather than null")
	}
}

func TestConfigEndpoint_RejectsWrites(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, configPath, nil)
	w := httptest.NewRecorder()
	configHandler(config{mode: modeStatic}, noAuth{}).ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("want 405, got %d", w.Code)
	}
	if allow := w.Header().Get("Allow"); allow == "" {
		t.Fatal("want an Allow header on 405")
	}
}
