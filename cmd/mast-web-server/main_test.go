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
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// ─── spaHandler ─────────────────────────────────────────────────────

func TestSPAHandler_ServesIndex(t *testing.T) {
	fs := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>root</html>")},
	}
	srv := httptest.NewServer(spaHandler(fs))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "<html>root</html>") {
		t.Fatalf("want index.html body, got %q", string(body))
	}
}

func TestSPAHandler_FallsBackToIndexForUnknownRoutes(t *testing.T) {
	fs := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>root</html>")},
	}
	srv := httptest.NewServer(spaHandler(fs))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/some/client/route")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "root") {
		t.Fatalf("want index.html fallback, got %q", string(body))
	}
}

func TestSPAHandler_ServesNamedAssets(t *testing.T) {
	fs := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>root</html>")},
		"app.js":     &fstest.MapFile{Data: []byte("console.log('hi');")},
	}
	srv := httptest.NewServer(spaHandler(fs))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/app.js")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "console.log") {
		t.Fatalf("want app.js body, got %q", string(body))
	}
}

func TestSPAHandler_SetsNoCacheHeader(t *testing.T) {
	fs := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("root")},
	}
	srv := httptest.NewServer(spaHandler(fs))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	cc := resp.Header.Get("Cache-Control")
	if !strings.Contains(cc, "no-cache") {
		t.Fatalf("want no-cache in Cache-Control, got %q", cc)
	}
}

// ─── newBackendProxy ────────────────────────────────────────────────

func TestBackendProxy_ForwardsRequests(t *testing.T) {
	var seenAuth string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"path":"` + r.URL.Path + `"}`))
	}))
	t.Cleanup(backend.Close)

	proxy, err := newBackendProxy(proxyOptions{backendURL: backend.URL})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.StripPrefix("/attach", proxy))
	t.Cleanup(srv.Close)

	req, _ := http.NewRequest("GET", srv.URL+"/attach/sessions", nil)
	req.Header.Set("Authorization", "Bearer client-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"path":"/sessions"`) {
		t.Fatalf("want stripped path forwarded, got %q", string(body))
	}
	// auth-mode=none with no BACKEND_TOKEN is the per-operator token
	// mode the setup modal drives: the browser deliberately holds the
	// credential, so it must still reach the backend untouched.
	if seenAuth != "Bearer client-token" {
		t.Fatalf("want client token passed through, got %q", seenAuth)
	}
}

func TestBackendProxy_InjectsServerToken(t *testing.T) {
	var seenAuth, seenXAttach string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		seenXAttach = r.Header.Get("X-Attach-Token")
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(backend.Close)

	proxy, err := newBackendProxy(proxyOptions{backendURL: backend.URL, backendToken: "server-token"})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.StripPrefix("/attach", proxy))
	t.Cleanup(srv.Close)

	req, _ := http.NewRequest("GET", srv.URL+"/attach/sessions", nil)
	req.Header.Set("Authorization", "Bearer client-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if seenAuth != "Bearer server-token" {
		t.Fatalf("want server token injected, got %q", seenAuth)
	}
	if seenXAttach != "server-token" {
		t.Fatalf("want X-Attach-Token injected, got %q", seenXAttach)
	}
}

func TestBackendProxy_RejectsNonHTTPSchemes(t *testing.T) {
	_, err := newBackendProxy(proxyOptions{backendURL: "ftp://example.com"})
	if err == nil {
		t.Fatal("want error for ftp:// scheme, got nil")
	}
}

// ─── parseFlags ──────────────────────────────────────────────────────

func TestParseFlags_AutoSelectsStaticWithoutBackendURL(t *testing.T) {
	t.Setenv("BACKEND_URL", "")
	cfg, err := parseFlags(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.mode != modeStatic {
		t.Fatalf("want mode=static, got %q", cfg.mode)
	}
}

func TestParseFlags_AutoSelectsProxyWithBackendURL(t *testing.T) {
	cfg, err := parseFlags([]string{"--backend-url=http://example"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.mode != modeProxy {
		t.Fatalf("want mode=proxy, got %q", cfg.mode)
	}
}

func TestParseFlags_ExplicitModeOverrides(t *testing.T) {
	cfg, err := parseFlags([]string{"--mode=static", "--backend-url=http://example"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.mode != modeStatic {
		t.Fatalf("want mode=static (explicit), got %q", cfg.mode)
	}
}

func TestParseFlags_ProxyRequiresBackendURL(t *testing.T) {
	t.Setenv("BACKEND_URL", "")
	_, err := parseFlags([]string{"--mode=proxy"})
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !strings.Contains(err.Error(), "backend-url") {
		t.Fatalf("want 'backend-url' in error, got %q", err.Error())
	}
}

func TestParseFlags_MockRequiresFixturesDir(t *testing.T) {
	t.Setenv("MOCK_FIXTURES_DIR", "")
	_, err := parseFlags([]string{"--mode=mock"})
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !strings.Contains(err.Error(), "fixtures-dir") {
		t.Fatalf("want 'fixtures-dir' in error, got %q", err.Error())
	}
}

func TestParseFlags_MockFixturesDirDerivedFromWebDir(t *testing.T) {
	cfg, err := parseFlags([]string{"--mode=mock", "--web-dir=web"})
	if err != nil {
		t.Fatal(err)
	}
	want := "web/attach-core/conformance/fixtures"
	if cfg.fixturesDir != want {
		t.Fatalf("want fixtures-dir %q, got %q", want, cfg.fixturesDir)
	}
}

func TestParseFlags_UnknownMode(t *testing.T) {
	_, err := parseFlags([]string{"--mode=bogus"})
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !strings.Contains(err.Error(), "unknown --mode") {
		t.Fatalf("want 'unknown --mode' in error, got %q", err.Error())
	}
}

func TestParseFlags_APIPrefixNormalization(t *testing.T) {
	// Leading slash added; trailing slash stripped.
	cfg, err := parseFlags([]string{
		"--mode=proxy",
		"--backend-url=http://example",
		"--api-prefix=attach/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.apiPrefix != "/attach" {
		t.Fatalf("want /attach, got %q", cfg.apiPrefix)
	}
}

// ─── parseFlags: hosted-mode validation ─────────────────────────────

// clearAuthEnv keeps a developer's shell out of the table below.
func clearAuthEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"AUTH_MODE", "AUTH_HEADER", "IAP_AUDIENCE", "BACKEND_AUTH",
		"BACKEND_AUDIENCE", "EXTERNAL_URL", "SSE_MAX_LIFETIME",
		"ALLOW_UNAUTHENTICATED", "BACKEND_URL", "MODE",
	} {
		t.Setenv(k, "")
	}
}

func TestParseFlags_AuthModeValidation(t *testing.T) {
	const backend = "--backend-url=http://example"
	tests := []struct {
		name    string
		args    []string
		wantErr string // substring; empty means the config must be accepted
	}{
		{"default is none", []string{backend}, ""},
		{"proxy-header with a header", []string{backend, "--auth-mode=proxy-header", "--auth-header=X-User"}, ""},
		{"proxy-header without a header", []string{backend, "--auth-mode=proxy-header"}, "auth-header"},
		{"iap-jwt with an audience", []string{backend, "--auth-mode=iap-jwt", "--iap-audience=aud-1"}, ""},
		{"iap-jwt without an audience", []string{backend, "--auth-mode=iap-jwt"}, "iap-audience"},
		{"unknown mode", []string{backend, "--auth-mode=magic"}, "unknown --auth-mode"},
		// Reserved rather than unknown, so the error names the way out.
		{"oidc is reserved", []string{backend, "--auth-mode=oidc"}, "not implemented yet"},
		// Authenticating the human is meaningless when this server does
		// not carry the traffic. Error, never a silent downgrade.
		{"auth without proxy mode", []string{"--mode=static", "--auth-mode=proxy-header", "--auth-header=X-User"}, "requires --mode=proxy"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearAuthEnv(t)
			_, err := parseFlags(tc.args)
			switch {
			case tc.wantErr == "" && err != nil:
				t.Fatalf("want accepted, got %v", err)
			case tc.wantErr != "" && err == nil:
				t.Fatalf("want error containing %q, got nil", tc.wantErr)
			case tc.wantErr != "" && !strings.Contains(err.Error(), tc.wantErr):
				t.Fatalf("want error containing %q, got %q", tc.wantErr, err.Error())
			}
		})
	}
}

func TestParseFlags_BackendAuthValidation(t *testing.T) {
	const backend = "--backend-url=http://example"
	tests := []struct {
		name    string
		args    []string
		wantErr string
	}{
		{"bearer is the default", []string{backend}, ""},
		{"google-oauth", []string{backend, "--backend-auth=google-oauth"}, ""},
		{"google-id-token defaults its audience to the backend URL", []string{backend, "--backend-auth=google-id-token"}, ""},
		{"google-id-token with no audience and no backend URL", []string{"--mode=proxy", "--backend-url=http://x", "--backend-auth=google-id-token", "--backend-audience="}, ""},
		{"unknown kind", []string{backend, "--backend-auth=kerberos"}, "unknown --backend-auth"},
		{"google modes need proxy mode", []string{"--mode=static", "--backend-auth=google-oauth"}, "requires --mode=proxy"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearAuthEnv(t)
			_, err := parseFlags(tc.args)
			switch {
			case tc.wantErr == "" && err != nil:
				t.Fatalf("want accepted, got %v", err)
			case tc.wantErr != "" && err == nil:
				t.Fatalf("want error containing %q, got nil", tc.wantErr)
			case tc.wantErr != "" && !strings.Contains(err.Error(), tc.wantErr):
				t.Fatalf("want error containing %q, got %q", tc.wantErr, err.Error())
			}
		})
	}
}

func TestParseFlags_GoogleIDTokenAudienceDefaultsToBackendURL(t *testing.T) {
	clearAuthEnv(t)
	cfg, err := parseFlags([]string{"--backend-url=https://agent.example.com", "--backend-auth=google-id-token"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.backendAudience != "https://agent.example.com" {
		t.Fatalf("backend-audience = %q", cfg.backendAudience)
	}
}

func TestParseFlags_ExternalURLNormalization(t *testing.T) {
	clearAuthEnv(t)
	cfg, err := parseFlags([]string{"--backend-url=http://example", "--external-url=https://mast.example.com/ui/"})
	if err != nil {
		t.Fatal(err)
	}
	// Normalized to a bare origin so the CSRF check is a plain string
	// comparison against what a browser puts in Origin.
	if cfg.externalURL != "https://mast.example.com" {
		t.Fatalf("external-url = %q", cfg.externalURL)
	}

	clearAuthEnv(t)
	if _, err := parseFlags([]string{"--backend-url=http://example", "--external-url=mast.example.com"}); err == nil {
		t.Fatal("want error for a scheme-less --external-url")
	}
}

func TestParseFlags_SSEMaxLifetimeDefault(t *testing.T) {
	clearAuthEnv(t)
	cfg, err := parseFlags([]string{"--backend-url=http://example"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.sseMaxLifetime != 30*time.Minute {
		t.Fatalf("sse-max-lifetime = %s, want 30m", cfg.sseMaxLifetime)
	}

	clearAuthEnv(t)
	if _, err := parseFlags([]string{"--backend-url=http://example", "--sse-max-lifetime=-1s"}); err == nil {
		t.Fatal("want error for a negative --sse-max-lifetime")
	}
}

// ─── startupWarnings ─────────────────────────────────────────────────

func TestStartupWarnings_OpenProxy(t *testing.T) {
	open := config{mode: modeProxy, authMode: authModeNone, listen: ":8080", backendURL: "http://agent"}
	if got := startupWarnings(open); len(got) != 1 || !strings.Contains(got[0], "SECURITY") {
		t.Fatalf("want a security warning for an open non-loopback proxy, got %v", got)
	}

	// Loopback is the developer's shape and must stay quiet.
	for _, addr := range []string{"127.0.0.1:8080", "localhost:8080", "[::1]:8080"} {
		quiet := open
		quiet.listen = addr
		if got := startupWarnings(quiet); len(got) != 0 {
			t.Fatalf("listen=%s: want no warning, got %v", addr, got)
		}
	}

	acked := open
	acked.allowUnauthenticated = true
	if got := startupWarnings(acked); len(got) != 0 {
		t.Fatalf("want no warning once acknowledged, got %v", got)
	}
}

func TestStartupWarnings_ProxyHeaderIsAlwaysCalledOut(t *testing.T) {
	// proxy-header trust is unenforceable from in-process; the warning
	// is the only mitigation this binary can offer.
	cfg := config{mode: modeProxy, authMode: authModeProxyHeader, authHeader: "X-User", listen: ":8080"}
	got := startupWarnings(cfg)
	if len(got) != 1 || !strings.Contains(got[0], "X-User") {
		t.Fatalf("want a warning naming the trusted header, got %v", got)
	}
}

func TestIsLoopbackListen(t *testing.T) {
	tests := map[string]bool{
		"127.0.0.1:8080": true,
		"localhost:8080": true,
		"[::1]:8080":     true,
		// A bare port binds every interface — the case operators most
		// often mistake for "just local".
		":8080":         false,
		"0.0.0.0:8080":  false,
		"10.0.0.5:8080": false,
		"":              false,
	}
	for addr, want := range tests {
		if got := isLoopbackListen(addr); got != want {
			t.Errorf("isLoopbackListen(%q) = %v, want %v", addr, got, want)
		}
	}
}
