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
//	--backend-token=<token>    (BACKEND_TOKEN)      server-injected bearer token
//	                                                for proxied requests
//	--fixture=<name>           (MOCK_FIXTURE)       default fixture in mock mode
//	--frame-delay-ms=150       (MOCK_FRAME_DELAY_MS) SSE frame pacing in mock mode
//	--fixtures-dir=<path>      (MOCK_FIXTURES_DIR)  fixture source dir; defaults to
//	                                                <web-dir>/attach-core/conformance/
//	                                                fixtures/ when web-dir is set
//
// Routes (present in every mode):
//
//	GET /healthz       — liveness probe (always 200)
//	GET /readyz        — readiness probe (always 200)
//	GET /*             — SPA static assets (from embed or --web-dir)
//
// Mode-specific routes are documented in proxy.go / mock.go.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
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
	return cfg, nil
}

// run wires the HTTP server per config and blocks on ListenAndServe.
// Split from main so tests can drive it against an httptest server.
func run(cfg config) error {
	mux, err := buildMux(cfg)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              cfg.listen,
		Handler:           withLogging(mux),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout — SSE streams are long-lived. The reverse
		// proxy handles its own flush-on-write via FlushInterval=-1.
	}
	log.Printf("mast-web-server: mode=%s listen=%s", cfg.mode, cfg.listen)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("listen: %w", err)
	}
	return nil
}

// buildMux constructs the HTTP handler set for the given mode without
// binding a listener. Exposed for tests via httptest.NewServer.
func buildMux(cfg config) (http.Handler, error) {
	mux := http.NewServeMux()

	// Health probes present in every mode.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ready"))
	})

	// Mode-specific handlers registered before the SPA fallthrough
	// so their routes take precedence.
	switch cfg.mode {
	case modeProxy:
		proxy, err := newBackendProxy(cfg.backendURL, cfg.backendToken)
		if err != nil {
			return nil, fmt.Errorf("backend proxy: %w", err)
		}
		mux.Handle(cfg.apiPrefix+"/", http.StripPrefix(cfg.apiPrefix, proxy))
		log.Printf("proxy: %s/* -> %s", cfg.apiPrefix, cfg.backendURL)
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
	return mux, nil
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
func withLogging(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lw := &loggingWriter{ResponseWriter: w, status: http.StatusOK}
		h.ServeHTTP(lw, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, lw.status, time.Since(start))
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
