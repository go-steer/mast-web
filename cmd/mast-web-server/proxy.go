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
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/idtoken"
)

// Backend credential kinds. Names deliberately match core-agent-tui's
// resolveCredentials (cmd/core-agent-tui/auth.go) so an operator learns
// one vocabulary across the TUI and the web UI.
const (
	backendAuthBearer        = "bearer"
	backendAuthGoogleOAuth   = "google-oauth"
	backendAuthGoogleIDToken = "google-id-token"
)

// cloudPlatformScope is the scope core-agent-tui requests for
// google-oauth; matching it keeps a single ADC consent surface.
const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform"

type proxyOptions struct {
	backendURL string

	// backendToken is BACKEND_TOKEN — the attach shared secret. In
	// bearer mode it is the whole credential; in the Google modes it
	// still rides on X-Attach-Token, matching attachclient's split of
	// "Google token authenticates the workload, attach token
	// authenticates the client".
	backendToken string

	// credential resolves a Google token per request (cached by the
	// underlying oauth2.TokenSource). nil in bearer mode.
	credential backendCredential

	// authEnabled is auth-mode != none: this proxy is a BFF, the caller
	// has been authenticated at our edge, and every client-supplied
	// credential must be scrubbed.
	authEnabled bool

	// sseMaxLifetime bounds a proxied request. Auth is checked only at
	// connect, so without a bound a stream opened just before an
	// identity is revoked outlives it indefinitely. The browser's
	// EventSource reconnects on its own and re-authenticates.
	sseMaxLifetime time.Duration
}

// backendCredential resolves the server-side credential presented to
// the agent.
type backendCredential interface {
	token(ctx context.Context) (string, error)
	kind() string
}

type googleCredential struct {
	name string
	ts   oauth2.TokenSource
}

func (g *googleCredential) kind() string { return g.name }

func (g *googleCredential) token(_ context.Context) (string, error) {
	t, err := g.ts.Token()
	if err != nil {
		return "", err
	}
	// idtoken.NewTokenSource returns the ID token in AccessToken.
	return t.AccessToken, nil
}

// newBackendCredential resolves the outbound credential at startup so a
// missing ADC or an unreachable metadata server is a boot failure with
// a clear message rather than a stream of 401s from the agent.
func newBackendCredential(ctx context.Context, cfg config) (backendCredential, error) {
	switch cfg.backendAuth {
	case "", backendAuthBearer:
		return nil, nil
	case backendAuthGoogleOAuth:
		creds, err := google.FindDefaultCredentials(ctx, cloudPlatformScope)
		if err != nil {
			return nil, fmt.Errorf("google-oauth: find default credentials: %w", err)
		}
		return &googleCredential{name: backendAuthGoogleOAuth, ts: creds.TokenSource}, nil
	case backendAuthGoogleIDToken:
		ts, err := idtoken.NewTokenSource(ctx, cfg.backendAudience)
		if err != nil {
			return nil, fmt.Errorf("google-id-token: token source for audience %q: %w", cfg.backendAudience, err)
		}
		return &googleCredential{name: backendAuthGoogleIDToken, ts: ts}, nil
	default:
		return nil, fmt.Errorf("unknown --backend-auth %q", cfg.backendAuth)
	}
}

type ctxKeyBackendToken struct{}

// backendProxy is the reverse proxy plus the per-request work that has
// to happen before httputil.ReverseProxy takes over: resolving the
// outbound credential (which can fail, and Rewrite cannot return an
// error) and bounding the request's lifetime.
type backendProxy struct {
	rp   *httputil.ReverseProxy
	opts proxyOptions
}

func (p *backendProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Fail closed on a missing identity. When auth is enabled the caller
	// has already been verified by withAuth, which records it in the
	// holder withLogging seeds — so an empty caller here means the
	// middleware chain is not what we think it is, not that the user is
	// anonymous. Proxying anyway would send no X-Asserted-Caller, and
	// the agent would apply the *proxy's* own identity, which is exactly
	// the identity that is allowed to speak for everyone. Refuse rather
	// than silently escalate.
	if p.opts.authEnabled {
		info := requestInfoFrom(r.Context())
		if info == nil || info.caller == "" {
			log.Printf("proxy: refusing %s %s: auth is enabled but no caller was resolved", r.Method, r.URL.Path)
			http.Error(w, "no caller identity to assert", http.StatusInternalServerError)
			return
		}
	}
	if p.opts.credential != nil {
		tok, err := p.opts.credential.token(r.Context())
		if err != nil {
			log.Printf("proxy: resolve %s credential: %v", p.opts.credential.kind(), err)
			http.Error(w, "backend credential unavailable", http.StatusBadGateway)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), ctxKeyBackendToken{}, tok))
	}
	if p.opts.sseMaxLifetime > 0 {
		ctx, cancel := context.WithTimeout(r.Context(), p.opts.sseMaxLifetime)
		defer cancel()
		r = r.WithContext(ctx)
	}
	p.rp.ServeHTTP(w, r)
}

// newBackendProxy builds the reverse proxy for the attach API.
// FlushInterval=-1 is essential — without it the proxy buffers SSE
// frames and the SPA never sees real-time updates.
//
// Header handling, which is the security-relevant part:
//
//   - X-Asserted-Caller supplied by a client is always deleted. A
//     browser has no legitimate reason to send it, and forwarding it
//     would let anyone who can reach this port impersonate any user the
//     agent's proxy_identities allowlist trusts us to assert.
//   - Origin and Referer are always stripped on the way out. This is
//     not a workaround for core-agent's browserWriteGuard, it is the
//     honest signal: pkg/attach/csrf.go documents that native clients
//     send no Origin and pass through untouched, and once the BFF
//     enforces CSRF at its own edge (withCSRF) it *is* a native client.
//     Without this every write 403s, because the browser's Origin is
//     this server's while the outbound Host is the backend's.
//   - Authorization / X-Attach-Token / Cookie from the client are
//     deleted whenever auth is enabled, before the server-side
//     credential is stamped on. In auth-mode=none with no BACKEND_TOKEN
//     the client's own headers still flow through untouched — that is
//     the per-operator token mode the setup modal drives, where the
//     browser deliberately holds the credential.
func newBackendProxy(opts proxyOptions) (http.Handler, error) {
	target, err := url.Parse(opts.backendURL)
	if err != nil {
		return nil, fmt.Errorf("parse backend URL %q: %w", opts.backendURL, err)
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, fmt.Errorf("backend URL must be http(s); got %q", target.Scheme)
	}

	rp := &httputil.ReverseProxy{
		// Flush immediately on each chunk — required for SSE.
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.SetXForwarded()

			pr.Out.Header.Del(assertedCallerHeader)
			pr.Out.Header.Del("Origin")
			pr.Out.Header.Del("Referer")

			if opts.authEnabled {
				pr.Out.Header.Del("Authorization")
				pr.Out.Header.Del("X-Attach-Token")
				pr.Out.Header.Del("Cookie")
			}

			if opts.backendToken != "" {
				pr.Out.Header.Set("X-Attach-Token", opts.backendToken)
				pr.Out.Header.Set("Authorization", "Bearer "+opts.backendToken)
			}
			// A Google token, when configured, wins the Authorization
			// slot; the attach secret stays on X-Attach-Token.
			if tok, ok := pr.In.Context().Value(ctxKeyBackendToken{}).(string); ok && tok != "" {
				pr.Out.Header.Set("Authorization", "Bearer "+tok)
			}

			if opts.authEnabled {
				if info := requestInfoFrom(pr.In.Context()); info != nil && info.caller != "" {
					pr.Out.Header.Set(assertedCallerHeader, info.caller)
				}
			}
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// A deadline hit on a long-lived SSE stream is the
			// sse-max-lifetime cap doing its job, not a backend fault.
			if r.Context().Err() != nil {
				log.Printf("proxy: %s %s closed: %v", r.Method, r.URL.Path, r.Context().Err())
				return
			}
			log.Printf("proxy error %s %s: %v", r.Method, r.URL.Path, err)
			http.Error(w, "backend unreachable: "+err.Error(), http.StatusBadGateway)
		},
	}
	return &backendProxy{rp: rp, opts: opts}, nil
}
