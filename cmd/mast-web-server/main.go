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

// mast-web-server — Go binary that serves the mast-web SPA in one of
// three modes:
//
//	proxy  — SPA + reverse-proxy to a real mast / core-agent backend.
//	         Same-origin, no CORS. Container-image deployment shape.
//	mock   — SPA + local mock backend fed from JSONL conformance
//	         fixtures. Zero external deps, no credentials, no daemon.
//	         Used by `make smoke` for local end-to-end testing and
//	         by cloud dev-environment operators (Cloud Workstations,
//	         Codespaces, gitpod) who can't cross subdomain auth.
//	static — SPA only. Operator points the SPA at a backend of their
//	         choice via the setup modal; useful when iterating on
//	         SPA source against a running real backend.
//
// In proxy mode the server can also act as a backend-for-frontend: it
// authenticates the human at its own edge and forwards that identity to
// the agent as X-Asserted-Caller, so the browser never holds an agent
// credential. See auth.go.
//
// Configuration via flags (each also honors an env var):
//
//	--listen=:8080             (LISTEN)             bind address
//	--mode=proxy|mock|static   (MODE)               explicit mode; if unset,
//	                                                proxy when BACKEND_URL is set,
//	                                                else static
//	--web-dir=<path>           (WEB_DIR)            serve SPA from this filesystem
//	                                                path instead of the embedded
//	                                                bundle; useful for dev iteration
//	--api-prefix=/attach       (API_PREFIX)         request prefix routed to the
//	                                                proxy in proxy mode
//	--backend-url=<url>        (BACKEND_URL)        target for proxy mode
//	--backend-token=<token>    (BACKEND_TOKEN)      server-injected attach token
//	                                                for proxied requests
//	--fixture=<name>           (MOCK_FIXTURE)       default fixture in mock mode
//	--frame-delay-ms=150       (MOCK_FRAME_DELAY_MS) SSE frame pacing in mock mode
//	--fixtures-dir=<path>      (MOCK_FIXTURES_DIR)  fixture source dir; defaults to
//	                                                <web-dir>/attach-core/conformance/
//	                                                fixtures/ when web-dir is set
//
// Hosted / multi-user configuration (proxy mode only):
//
//	--auth-mode=none           (AUTH_MODE)          none | proxy-header | iap-jwt
//	--auth-header=<name>       (AUTH_HEADER)        identity header, proxy-header mode
//	--iap-audience=<aud>       (IAP_AUDIENCE)       expected aud, iap-jwt mode
//	--backend-auth=bearer      (BACKEND_AUTH)       bearer | google-oauth |
//	                                                google-id-token
//	--backend-audience=<aud>   (BACKEND_AUDIENCE)   audience for google-id-token;
//	                                                defaults to --backend-url
//	--external-url=<url>       (EXTERNAL_URL)       canonical public origin
//	--sse-max-lifetime=30m     (SSE_MAX_LIFETIME)   cap on a proxied request
//	--allow-unauthenticated    (ALLOW_UNAUTHENTICATED) acknowledge an open,
//	                                                non-loopback proxy
//
// Routes (present in every mode):
//
//	GET /healthz       — liveness probe (always 200)
//	GET /readyz        — readiness probe (always 200)
//	GET /config        — deployment + auth descriptor for the SPA
//	GET /*             — SPA static assets (from embed or --web-dir)
//
// Mode-specific routes are documented in proxy.go / mock.go.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-steer/mast-web/internal/webui"
)

// Mode names. Kept as constants so tests + flag parsing agree on the
// exact strings we accept.
const (
	modeProxy  = "proxy"
	modeMock   = "mock"
	modeStatic = "static"
)

type config struct {
	listen       string
	mode         string
	webDir       string
	apiPrefix    string
	backendURL   string
	backendToken string
	fixture      string
	frameDelayMs int
	fixturesDir  string

	// Hosted / multi-user knobs. See auth.go and proxy.go.
	authMode             string
	authHeader           string
	iapAudience          string
	backendAuth          string
	backendAudience      string
	externalURL          string
	sseMaxLifetime       time.Duration
	allowUnauthenticated bool
}

func main() {
	cfg, err := parseFlags(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err := run(cfg); err != nil {
		log.Fatalf("mast-web-server: %v", err)
	}
}

// parseFlags reads flags + env into a config, applies defaults, and
// validates. Exposed for tests.
func parseFlags(args []string) (config, error) {
	fs := flag.NewFlagSet("mast-web-server", flag.ContinueOnError)
	// Silence flag's own usage on parse errors — main handles output.
	fs.SetOutput(os.Stderr)

	cfg := config{}
	fs.StringVar(&cfg.listen, "listen", envOr("LISTEN", ":8080"), "bind address (env: LISTEN)")
	fs.StringVar(&cfg.mode, "mode", envOr("MODE", ""), "server mode: proxy | mock | static (env: MODE)")
	fs.StringVar(&cfg.webDir, "web-dir", envOr("WEB_DIR", ""), "serve SPA from this filesystem path instead of the embedded bundle (env: WEB_DIR)")
	fs.StringVar(&cfg.apiPrefix, "api-prefix", envOr("API_PREFIX", "/attach"), "proxy-mode request prefix routed to the backend (env: API_PREFIX)")
	fs.StringVar(&cfg.backendURL, "backend-url", os.Getenv("BACKEND_URL"), "proxy-mode target URL (env: BACKEND_URL)")
	fs.StringVar(&cfg.backendToken, "backend-token", os.Getenv("BACKEND_TOKEN"), "proxy-mode server-injected bearer token (env: BACKEND_TOKEN)")
	fs.StringVar(&cfg.fixture, "fixture", envOr("MOCK_FIXTURE", "001-happy-turn"), "mock-mode default fixture name (env: MOCK_FIXTURE)")
	frameDelayDefault, _ := strconv.Atoi(envOr("MOCK_FRAME_DELAY_MS", "150"))
	fs.IntVar(&cfg.frameDelayMs, "frame-delay-ms", frameDelayDefault, "mock-mode delay between SSE frames (env: MOCK_FRAME_DELAY_MS)")
	fs.StringVar(&cfg.fixturesDir, "fixtures-dir", os.Getenv("MOCK_FIXTURES_DIR"), "mock-mode fixture source dir; defaults to <web-dir>/attach-core/conformance/fixtures/ (env: MOCK_FIXTURES_DIR)")

	fs.StringVar(&cfg.authMode, "auth-mode", envOr("AUTH_MODE", authModeNone), "how the human is authenticated: none | proxy-header | iap-jwt (env: AUTH_MODE)")
	// No default header name on purpose. A default would be a name an
	// attacker could guess is trusted, on a port that might be directly
	// reachable; making the operator name it forces the thought.
	fs.StringVar(&cfg.authHeader, "auth-header", os.Getenv("AUTH_HEADER"), "identity header set by the fronting proxy; required for --auth-mode=proxy-header (env: AUTH_HEADER)")
	fs.StringVar(&cfg.iapAudience, "iap-audience", os.Getenv("IAP_AUDIENCE"), "expected aud claim of the IAP assertion; required for --auth-mode=iap-jwt (env: IAP_AUDIENCE)")
	fs.StringVar(&cfg.backendAuth, "backend-auth", envOr("BACKEND_AUTH", backendAuthBearer), "credential presented to the backend: bearer | google-oauth | google-id-token (env: BACKEND_AUTH)")
	fs.StringVar(&cfg.backendAudience, "backend-audience", os.Getenv("BACKEND_AUDIENCE"), "audience for --backend-auth=google-id-token; defaults to --backend-url (env: BACKEND_AUDIENCE)")
	fs.StringVar(&cfg.externalURL, "external-url", os.Getenv("EXTERNAL_URL"), "canonical public origin of this deployment, used for the CSRF origin check (env: EXTERNAL_URL)")
	sseDefault, err := time.ParseDuration(envOr("SSE_MAX_LIFETIME", "30m"))
	if err != nil {
		return config{}, fmt.Errorf("SSE_MAX_LIFETIME: %w", err)
	}
	fs.DurationVar(&cfg.sseMaxLifetime, "sse-max-lifetime", sseDefault, "cap on the lifetime of a proxied request; 0 disables (env: SSE_MAX_LIFETIME)")
	fs.BoolVar(&cfg.allowUnauthenticated, "allow-unauthenticated", envBool("ALLOW_UNAUTHENTICATED"), "acknowledge running an unauthenticated proxy on a non-loopback address (env: ALLOW_UNAUTHENTICATED)")

	if err := fs.Parse(args); err != nil {
		return config{}, err
	}

	// Auto-select mode when unset: proxy if backend URL, else static.
	// Explicitly recognizes empty string as "unset" so operators can
	// override MODE=... with a --mode="" (rare).
	if cfg.mode == "" {
		if cfg.backendURL != "" {
			cfg.mode = modeProxy
		} else {
			cfg.mode = modeStatic
		}
	}

	// Normalize api-prefix — leading slash required, no trailing.
	if !strings.HasPrefix(cfg.apiPrefix, "/") {
		cfg.apiPrefix = "/" + cfg.apiPrefix
	}
	cfg.apiPrefix = strings.TrimRight(cfg.apiPrefix, "/")

	// Fixture-dir default: derive from web-dir when possible so
	// operators running mock mode against a checkout don't need two
	// flags. Explicit --fixtures-dir always wins.
	if cfg.mode == modeMock && cfg.fixturesDir == "" && cfg.webDir != "" {
		cfg.fixturesDir = cfg.webDir + "/attach-core/conformance/fixtures"
	}

	// Mode-specific validation.
	switch cfg.mode {
	case modeProxy:
		if cfg.backendURL == "" {
			return config{}, errors.New("mode=proxy requires --backend-url or BACKEND_URL")
		}
	case modeMock:
		if cfg.fixturesDir == "" {
			return config{}, errors.New("mode=mock requires --fixtures-dir or --web-dir (which sets fixtures-dir automatically)")
		}
	case modeStatic:
		// No required inputs.
	default:
		return config{}, fmt.Errorf("unknown --mode %q (want proxy | mock | static)", cfg.mode)
	}

	if err := validateAuthConfig(&cfg); err != nil {
		return config{}, err
	}
	return cfg, nil
}

// validateAuthConfig checks the hosted-mode knobs and fills in their
// derived defaults. Split out of parseFlags to keep that function
// readable; mutates cfg in place for the derived values.
func validateAuthConfig(cfg *config) error {
	switch cfg.authMode {
	case "", authModeNone:
		cfg.authMode = authModeNone
	case authModeProxyHeader:
		if cfg.authHeader == "" {
			return errors.New("--auth-mode=proxy-header requires --auth-header or AUTH_HEADER")
		}
	case authModeIAPJWT:
		if cfg.iapAudience == "" {
			return errors.New("--auth-mode=iap-jwt requires --iap-audience or IAP_AUDIENCE")
		}
	case authModeOIDC:
		return errors.New("--auth-mode=oidc is not implemented yet; use proxy-header or iap-jwt")
	default:
		return fmt.Errorf("unknown --auth-mode %q (want none | proxy-header | iap-jwt)", cfg.authMode)
	}

	// Authenticating the human is only meaningful when this server also
	// carries the traffic. In static or mock mode the SPA talks to a
	// backend directly and there is nothing here to gate. Error rather
	// than silently downgrading: a deployment that thinks it is
	// authenticating and is not is the worst outcome.
	if cfg.authMode != authModeNone && cfg.mode != modeProxy {
		return fmt.Errorf("--auth-mode=%s requires --mode=proxy (got %s)", cfg.authMode, cfg.mode)
	}

	switch cfg.backendAuth {
	case "", backendAuthBearer:
		cfg.backendAuth = backendAuthBearer
	case backendAuthGoogleOAuth:
		// Audience-free; ADC scopes carry the authorization.
	case backendAuthGoogleIDToken:
		if cfg.backendAudience == "" {
			cfg.backendAudience = cfg.backendURL
		}
		if cfg.backendAudience == "" {
			return errors.New("--backend-auth=google-id-token requires --backend-audience or --backend-url")
		}
	default:
		return fmt.Errorf("unknown --backend-auth %q (want bearer | google-oauth | google-id-token)", cfg.backendAuth)
	}
	if cfg.backendAuth != backendAuthBearer && cfg.mode != modeProxy {
		return fmt.Errorf("--backend-auth=%s requires --mode=proxy (got %s)", cfg.backendAuth, cfg.mode)
	}

	if cfg.sseMaxLifetime < 0 {
		return fmt.Errorf("--sse-max-lifetime must not be negative (got %s)", cfg.sseMaxLifetime)
	}

	if cfg.externalURL != "" {
		u, err := url.Parse(cfg.externalURL)
		if err != nil {
			return fmt.Errorf("--external-url %q: %w", cfg.externalURL, err)
		}
		if u.Scheme == "" || u.Host == "" {
			return fmt.Errorf("--external-url %q must be an absolute origin, e.g. https://mast.example.com", cfg.externalURL)
		}
		// Normalize to a bare origin so the CSRF comparison is a plain
		// string equality against what a browser puts in Origin.
		cfg.externalURL = u.Scheme + "://" + u.Host
	}
	return nil
}

// startupWarnings returns operator-facing warnings for configurations
// that are legal but easy to get wrong. Returned rather than logged so
// tests can assert on them.
func startupWarnings(cfg config) []string {
	var out []string
	if cfg.mode == modeProxy && cfg.authMode == authModeNone &&
		!cfg.allowUnauthenticated && !isLoopbackListen(cfg.listen) {
		out = append(out, fmt.Sprintf(
			"SECURITY: proxying to %s with --auth-mode=none on non-loopback %s — "+
				"anyone who can reach this port drives the agent. Set --auth-mode, "+
				"bind loopback, or pass --allow-unauthenticated to acknowledge. "+
				"This will become a hard error in a future release.",
			cfg.backendURL, cfg.listen))
	}
	if cfg.authMode == authModeProxyHeader {
		out = append(out, fmt.Sprintf(
			"SECURITY: --auth-mode=proxy-header trusts %s on every request. "+
				"This is only sound if the fronting proxy strips client-supplied "+
				"copies of that header and this port is not directly reachable.",
			cfg.authHeader))
	}
	return out
}

// isLoopbackListen reports whether a bind address reaches only the
// local host. A bare ":8080" binds every interface and is not loopback.
func isLoopbackListen(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// run wires the HTTP server per config and blocks on ListenAndServe.
// Split from main so tests can drive it against an httptest server.
func run(cfg config) error {
	ctx := context.Background()
	handler, err := buildMux(ctx, cfg)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              cfg.listen,
		Handler:           withLogging(handler),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout — SSE streams are long-lived. The reverse
		// proxy handles its own flush-on-write via FlushInterval=-1.
	}
	for _, w := range startupWarnings(cfg) {
		log.Print(w)
	}
	log.Printf("mast-web-server: mode=%s listen=%s auth-mode=%s", cfg.mode, cfg.listen, cfg.authMode)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("listen: %w", err)
	}
	return nil
}

// buildMux constructs the HTTP handler set for the given mode without
// binding a listener. Exposed for tests via httptest.NewServer.
func buildMux(ctx context.Context, cfg config) (http.Handler, error) {
	mux := http.NewServeMux()

	authn, err := newAuthenticator(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("authenticator: %w", err)
	}

	// Health probes present in every mode.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ready"))
	})
	// Deployment descriptor, present in every mode so the SPA has one
	// bootstrap path.
	mux.Handle(configPath, configHandler(cfg, authn))

	// Mode-specific handlers registered before the SPA fallthrough
	// so their routes take precedence.
	switch cfg.mode {
	case modeProxy:
		cred, err := newBackendCredential(ctx, cfg)
		if err != nil {
			return nil, fmt.Errorf("backend credential: %w", err)
		}
		proxy, err := newBackendProxy(proxyOptions{
			backendURL:     cfg.backendURL,
			backendToken:   cfg.backendToken,
			credential:     cred,
			authEnabled:    cfg.authMode != authModeNone,
			sseMaxLifetime: cfg.sseMaxLifetime,
		})
		if err != nil {
			return nil, fmt.Errorf("backend proxy: %w", err)
		}
		var api http.Handler = http.StripPrefix(cfg.apiPrefix, proxy)
		if cfg.authMode != authModeNone {
			api = withCSRF(cfg.externalURL, api)
		}
		mux.Handle(cfg.apiPrefix+"/", api)
		log.Printf("proxy: %s/* -> %s (backend-auth=%s)", cfg.apiPrefix, cfg.backendURL, cfg.backendAuth)
	case modeMock:
		mockHandler, err := newMockHandler(cfg)
		if err != nil {
			return nil, fmt.Errorf("mock: %w", err)
		}
		registerMockRoutes(mux, mockHandler)
		log.Printf("mock: fixture=%s frame-delay=%dms fixtures-dir=%s", cfg.fixture, cfg.frameDelayMs, cfg.fixturesDir)
	case modeStatic:
		// No backend handlers; SPA-only. Operator points the SPA at
		// a backend via the setup modal.
	}

	// SPA static assets — always last (fallthrough).
	spaFS, err := spaFS(cfg)
	if err != nil {
		return nil, fmt.Errorf("spa fs: %w", err)
	}
	mux.Handle("/", spaHandler(spaFS))

	if cfg.authMode == authModeNone {
		return mux, nil
	}
	return withAuth(authn, cfg.apiPrefix, mux), nil
}

// spaFS returns the filesystem the SPA is served from. Priority:
// --web-dir (dev iteration) > embedded bundle (production).
func spaFS(cfg config) (fs.FS, error) {
	if cfg.webDir != "" {
		info, err := os.Stat(cfg.webDir)
		if err != nil {
			return nil, fmt.Errorf("--web-dir %q: %w", cfg.webDir, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("--web-dir %q is not a directory", cfg.webDir)
		}
		return os.DirFS(cfg.webDir), nil
	}
	return webui.FS()
}

// withLogging wraps a handler with one-line access logging. No request
// body logging — keep this simple and PII-friendly.
//
// It sits outside withAuth so that rejected requests still produce a
// line, and seeds the per-request identity holder that withAuth fills
// in (see requestInfo). caller= is the audit trail for who drove the
// agent; "-" when the deployment authenticates nobody.
func withLogging(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ctx, info := withRequestInfo(r.Context())
		lw := &loggingWriter{ResponseWriter: w, status: http.StatusOK}
		h.ServeHTTP(lw, r.WithContext(ctx))
		caller := info.caller
		if caller == "" {
			caller = "-"
		}
		log.Printf("%s %s %d %s caller=%s", r.Method, r.URL.Path, lw.status, time.Since(start), caller)
	})
}

type loggingWriter struct {
	http.ResponseWriter
	status int
}

func (lw *loggingWriter) WriteHeader(code int) {
	lw.status = code
	lw.ResponseWriter.WriteHeader(code)
}

// Flush passes through to the underlying ResponseWriter so SSE
// streams flush correctly through the logging wrapper.
func (lw *loggingWriter) Flush() {
	if f, ok := lw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

// envBool reads a boolean env var. Anything strconv.ParseBool rejects
// (including "") is false — an unparseable value must not read as
// "yes, disable the safety check".
func envBool(name string) bool {
	v, err := strconv.ParseBool(os.Getenv(name))
	return err == nil && v
}
