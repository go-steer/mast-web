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
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

// captureBackend stands in for a real core-agent. It records the
// headers of the last request it saw.
type captureBackend struct {
	*httptest.Server
	seen http.Header
	path string
}

func newCaptureBackend(t *testing.T) *captureBackend {
	t.Helper()
	b := &captureBackend{}
	b.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b.seen = r.Header.Clone()
		b.path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(b.Close)
	return b
}

// proxyFront mounts proxy behind the same middleware stack buildMux
// uses, so tests exercise the composed behavior rather than a handler
// in isolation. caller is the identity withAuth would have resolved.
func proxyFront(t *testing.T, opts proxyOptions, caller string) *httptest.Server {
	t.Helper()
	proxy, err := newBackendProxy(opts)
	if err != nil {
		t.Fatal(err)
	}
	inner := http.StripPrefix("/attach", proxy)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, info := withRequestInfo(r.Context())
		info.caller = caller
		inner.ServeHTTP(w, r.WithContext(ctx))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestBackendProxy_AssertsAuthenticatedCaller(t *testing.T) {
	backend := newCaptureBackend(t)
	front := proxyFront(t, proxyOptions{
		backendURL:   backend.URL,
		backendToken: "server-token",
		authEnabled:  true,
	}, "alice@example.com")

	resp, err := http.Get(front.URL + "/attach/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if got := backend.seen.Get(assertedCallerHeader); got != "alice@example.com" {
		t.Fatalf("%s = %q, want alice@example.com", assertedCallerHeader, got)
	}
	if got := backend.seen.Get("X-Attach-Token"); got != "server-token" {
		t.Fatalf("X-Attach-Token = %q, want the server-side token", got)
	}
}

func TestBackendProxy_ScrubsClientSuppliedCredentials(t *testing.T) {
	// The whole point of the BFF: nothing the client sends may be used
	// to authenticate or to name an identity to the agent. Without the
	// X-Asserted-Caller scrub, enabling the proxy path is a direct
	// impersonation hole for anyone who can reach this port.
	backend := newCaptureBackend(t)
	front := proxyFront(t, proxyOptions{
		backendURL:   backend.URL,
		backendToken: "server-token",
		authEnabled:  true,
	}, "alice@example.com")

	req, _ := http.NewRequest("GET", front.URL+"/attach/sessions", nil)
	req.Header.Set(assertedCallerHeader, "root@example.com")
	req.Header.Set("Authorization", "Bearer stolen-token")
	req.Header.Set("X-Attach-Token", "stolen-token")
	req.Header.Set("Cookie", "session=abc123")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if got := backend.seen.Get(assertedCallerHeader); got != "alice@example.com" {
		t.Fatalf("client-supplied caller survived: %s = %q", assertedCallerHeader, got)
	}
	if got := backend.seen.Get("Authorization"); got != "Bearer server-token" {
		t.Fatalf("client Authorization survived: %q", got)
	}
	if got := backend.seen.Get("X-Attach-Token"); got != "server-token" {
		t.Fatalf("client X-Attach-Token survived: %q", got)
	}
	if got := backend.seen.Get("Cookie"); got != "" {
		t.Fatalf("client Cookie reached the agent: %q", got)
	}
}

func TestBackendProxy_ScrubsAssertedCallerEvenWithoutAuth(t *testing.T) {
	// A browser never has a legitimate reason to assert an identity,
	// so this one is unconditional — including in the per-operator
	// token mode where the client's own Authorization passes through.
	backend := newCaptureBackend(t)
	front := proxyFront(t, proxyOptions{backendURL: backend.URL}, "")

	req, _ := http.NewRequest("GET", front.URL+"/attach/sessions", nil)
	req.Header.Set(assertedCallerHeader, "root@example.com")
	req.Header.Set("Authorization", "Bearer operator-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if got := backend.seen.Get(assertedCallerHeader); got != "" {
		t.Fatalf("%s survived in auth-mode=none: %q", assertedCallerHeader, got)
	}
	if got := backend.seen.Get("Authorization"); got != "Bearer operator-token" {
		t.Fatalf("per-operator token mode broken: Authorization = %q", got)
	}
}

func TestBackendProxy_StripsOriginAndReferer(t *testing.T) {
	backend := newCaptureBackend(t)
	front := proxyFront(t, proxyOptions{backendURL: backend.URL, authEnabled: true}, "alice@example.com")

	req, _ := http.NewRequest("POST", front.URL+"/attach/sessions", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://mast.example.com")
	req.Header.Set("Referer", "https://mast.example.com/index.html")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if got := backend.seen.Get("Origin"); got != "" {
		t.Fatalf("Origin reached the agent: %q", got)
	}
	if got := backend.seen.Get("Referer"); got != "" {
		t.Fatalf("Referer reached the agent: %q", got)
	}
}

// browserWriteGuard is a faithful reimplementation of core-agent's
// pkg/attach/csrf.go guard, kept here so this repo can prove its
// outbound header handling against the real thing rather than against
// an assumption. Rules: every write method must carry a JSON
// Content-Type, and a *present* Origin must be loopback or self.
func browserWriteGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if !isJSONContentType(r.Header.Get("Content-Type")) {
			http.Error(w, "unsupported media type", http.StatusUnsupportedMediaType)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host == "" {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}
			host := u.Hostname()
			loopback := host == "localhost" || host == "127.0.0.1" || host == "::1"
			if !loopback && !strings.EqualFold(u.Host, r.Host) {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func TestBackendProxy_WriteSurvivesCoreAgentsCSRFGuard(t *testing.T) {
	// The regression test for the whole CSRF analysis. Before the
	// Origin strip, a browser-shaped write through the proxy 403'd at
	// the agent every time: the browser's Origin is this server's,
	// while the outbound Host is the backend's, so neither the
	// loopback branch nor the self branch matched.
	var reached bool
	backend := httptest.NewServer(browserWriteGuard(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		_, _ = w.Write([]byte(`{}`))
	})))
	t.Cleanup(backend.Close)

	front := proxyFront(t, proxyOptions{backendURL: backend.URL, authEnabled: true}, "alice@example.com")

	req, _ := http.NewRequest("DELETE", front.URL+"/attach/sessions/s1", nil)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://mast.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 through the agent's CSRF guard, got %d", resp.StatusCode)
	}
	if !reached {
		t.Fatal("request never reached the agent handler")
	}
}

// ─── backend credential ──────────────────────────────────────────────

type stubTokenSource struct {
	tok string
	err error
}

func (s stubTokenSource) Token() (*oauth2.Token, error) {
	if s.err != nil {
		return nil, s.err
	}
	return &oauth2.Token{AccessToken: s.tok, Expiry: time.Now().Add(time.Hour)}, nil
}

func TestBackendProxy_GoogleCredentialTakesAuthorizationSlot(t *testing.T) {
	backend := newCaptureBackend(t)
	front := proxyFront(t, proxyOptions{
		backendURL:   backend.URL,
		backendToken: "attach-secret",
		credential:   &googleCredential{name: backendAuthGoogleIDToken, ts: stubTokenSource{tok: "google-id-token-value"}},
		authEnabled:  true,
	}, "alice@example.com")

	resp, err := http.Get(front.URL + "/attach/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// Mirrors attachclient/credentials.go: the Google token
	// authenticates the workload, the attach secret authenticates the
	// client, and they ride on different headers.
	if got := backend.seen.Get("Authorization"); got != "Bearer google-id-token-value" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := backend.seen.Get("X-Attach-Token"); got != "attach-secret" {
		t.Fatalf("X-Attach-Token = %q", got)
	}
}

func TestBackendProxy_CredentialFailureIs502NotASilent401(t *testing.T) {
	backend := newCaptureBackend(t)
	front := proxyFront(t, proxyOptions{
		backendURL:  backend.URL,
		credential:  &googleCredential{name: backendAuthGoogleOAuth, ts: stubTokenSource{err: errors.New("metadata server unreachable")}},
		authEnabled: true,
	}, "alice@example.com")

	resp, err := http.Get(front.URL + "/attach/sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("want 502 when the credential cannot be resolved, got %d", resp.StatusCode)
	}
}

// ─── SSE lifetime cap ────────────────────────────────────────────────

func TestBackendProxy_CapsRequestLifetime(t *testing.T) {
	// Auth is only checked at connect, so an uncapped SSE stream
	// outlives any later revocation. The browser reconnects on its own
	// and re-authenticates.
	released := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-r.Context().Done() // held open until the proxy hangs up
		close(released)
	}))
	t.Cleanup(backend.Close)

	front := proxyFront(t, proxyOptions{
		backendURL:     backend.URL,
		authEnabled:    true,
		sseMaxLifetime: 100 * time.Millisecond,
	}, "alice@example.com")

	resp, err := http.Get(front.URL + "/attach/sessions/s1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	select {
	case <-released:
	case <-time.After(5 * time.Second):
		t.Fatal("stream outlived sse-max-lifetime")
	}
}

// ─── end to end through buildMux ─────────────────────────────────────

func TestBuildMux_ProxyHeaderModeEndToEnd(t *testing.T) {
	backend := newCaptureBackend(t)
	cfg := config{
		mode:         modeProxy,
		apiPrefix:    "/attach",
		backendURL:   backend.URL,
		backendToken: "server-token",
		authMode:     authModeProxyHeader,
		authHeader:   "X-Test-User",
		backendAuth:  backendAuthBearer,
		webDir:       t.TempDir(),
	}
	handler, err := buildMux(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(withLogging(handler))
	t.Cleanup(srv.Close)

	t.Run("authenticated request reaches the agent as the caller", func(t *testing.T) {
		req, _ := http.NewRequest("GET", srv.URL+"/attach/sessions", nil)
		req.Header.Set("X-Test-User", "alice@example.com")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("want 200, got %d", resp.StatusCode)
		}
		if got := backend.seen.Get(assertedCallerHeader); got != "alice@example.com" {
			t.Fatalf("%s = %q", assertedCallerHeader, got)
		}
	})

	t.Run("unauthenticated API request never reaches the agent", func(t *testing.T) {
		backend.seen = nil
		resp, err := http.Get(srv.URL + "/attach/sessions")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("want 401, got %d", resp.StatusCode)
		}
		if backend.seen != nil {
			t.Fatal("unauthenticated request was forwarded to the agent")
		}
	})

	t.Run("write without a JSON content type is refused at our edge", func(t *testing.T) {
		backend.seen = nil
		req, _ := http.NewRequest("POST", srv.URL+"/attach/sessions", strings.NewReader("x=1"))
		req.Header.Set("X-Test-User", "alice@example.com")
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusUnsupportedMediaType {
			t.Fatalf("want 415, got %d", resp.StatusCode)
		}
		if backend.seen != nil {
			t.Fatal("forgeable write was forwarded to the agent")
		}
	})

	t.Run("health probes stay open", func(t *testing.T) {
		resp, err := http.Get(srv.URL + "/healthz")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("want 200 for /healthz, got %d", resp.StatusCode)
		}
	})
}
