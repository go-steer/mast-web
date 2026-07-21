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

	proxy, err := newBackendProxy(backend.URL, "")
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

	proxy, err := newBackendProxy(backend.URL, "server-token")
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
	_, err := newBackendProxy("ftp://example.com", "")
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
