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

// mast-web-server — minimal static-file server for the mast-web SPA,
// with optional reverse-proxy to a mast / core-agent backend so the
// browser only ever talks to same-origin URLs (eliminates CORS as a
// concern entirely).
//
// Built to be packaged into a distroless container image
// (~10MB) per docs/web-design.md's container-deployment option.
//
// Configuration via environment variables:
//
//	LISTEN          ":8080"   — bind address
//	BACKEND_URL     ""        — if set, proxy <API_PREFIX>/* to this URL
//	API_PREFIX      "/attach" — request prefix routed to the backend proxy
//	BACKEND_TOKEN   ""        — if set, server injects `Authorization: Bearer <token>`
//	                            into proxied requests; SPA sends none. When unset
//	                            the proxy passes through whatever the SPA sent
//	                            (per-operator tokens). Honors both modes.
//
// Routes:
//
//	GET /healthz       — liveness probe (always 200)
//	GET /readyz        — readiness probe (always 200; backend reachability
//	                     deliberately not gated here — surface as Unavailable
//	                     from the proxy itself if it actually breaks)
//	<API_PREFIX>/*     — reverse proxy to BACKEND_URL (if configured)
//	/*                 — embedded SPA static assets
package main

import (
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"github.com/go-steer/mast-web/internal/webui"
)

func main() {
	listen := envOrDefault("LISTEN", ":8080")
	backendURL := os.Getenv("BACKEND_URL")
	apiPrefix := envOrDefault("API_PREFIX", "/attach")
	backendToken := os.Getenv("BACKEND_TOKEN")

	if !strings.HasPrefix(apiPrefix, "/") {
		apiPrefix = "/" + apiPrefix
	}
	apiPrefix = strings.TrimRight(apiPrefix, "/")

	mux := http.NewServeMux()

	// Health / readiness probes for K8s / Cloud Run.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ready"))
	})

	// Optional reverse proxy to the backend. When BACKEND_URL is unset,
	// the SPA must hit the backend cross-origin (mast-web becomes a
	// pure static host).
	if backendURL != "" {
		proxy, err := newBackendProxy(backendURL, apiPrefix, backendToken)
		if err != nil {
			log.Fatalf("backend proxy: %v", err)
		}
		mux.Handle(apiPrefix+"/", http.StripPrefix(apiPrefix, proxy))
		log.Printf("backend proxy: %s -> %s", apiPrefix+"/*", backendURL)
	} else {
		log.Printf("no BACKEND_URL set; SPA must talk to its backend cross-origin")
	}

	// Static assets — embedded SPA served from /.
	staticFS, err := webui.FS()
	if err != nil {
		log.Fatalf("embed dist subdir: %v", err)
	}
	mux.Handle("/", spaHandler(staticFS))

	srv := &http.Server{
		Addr:              listen,
		Handler:           withLogging(mux),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout — SSE streams are long-lived. The reverse
		// proxy handles its own flush-on-write via FlushInterval=-1.
	}

	log.Printf("mast-web-server listening on %s (api_prefix=%s)", listen, apiPrefix)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen: %v", err)
	}
}

// newBackendProxy builds a httputil.ReverseProxy for the attach API.
// FlushInterval=-1 is essential — without it the proxy buffers SSE
// frames and the SPA never sees real-time updates.
func newBackendProxy(rawURL, apiPrefix, injectedToken string) (*httputil.ReverseProxy, error) {
	target, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse BACKEND_URL %q: %w", rawURL, err)
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, fmt.Errorf("BACKEND_URL must be http(s); got %q", target.Scheme)
	}

	rp := &httputil.ReverseProxy{
		// Flush immediately on each chunk — required for SSE.
		FlushInterval: -1,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.SetXForwarded()
			// Server-injected token (when configured) wins over
			// whatever the SPA sent. Lets operators run the proxy in
			// "shared backend, single auth" mode where the SPA never
			// handles tokens.
			if injectedToken != "" {
				r.Out.Header.Set("Authorization", "Bearer "+injectedToken)
				r.Out.Header.Set("X-Attach-Token", injectedToken)
			}
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("proxy error %s %s: %v", r.Method, r.URL.Path, err)
			http.Error(w, "backend unreachable: "+err.Error(), http.StatusBadGateway)
		},
	}
	return rp, nil
}

// spaHandler serves the embedded SPA. Unknown paths fall back to
// index.html so client-side routes resolve (when we eventually add
// them); known assets (anything with a file extension) 404 cleanly.
func spaHandler(staticFS fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(staticFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Try the requested path first.
		clean := path.Clean(r.URL.Path)
		if clean == "/" {
			fileServer.ServeHTTP(w, r)
			return
		}
		// If the path has no file extension, treat it as a client-side
		// route and serve index.html.
		if path.Ext(clean) == "" {
			f, err := staticFS.Open(strings.TrimPrefix(clean, "/"))
			if err != nil {
				r2 := r.Clone(r.Context())
				r2.URL.Path = "/"
				fileServer.ServeHTTP(w, r2)
				return
			}
			_ = f.Close()
		}
		fileServer.ServeHTTP(w, r)
	})
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

func envOrDefault(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}
