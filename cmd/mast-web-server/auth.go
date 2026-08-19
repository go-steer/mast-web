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

// Human authentication for the hosted (backend-for-frontend) shape.
//
// In the hosted deployment the browser holds no agent credential at
// all. mast-web-server authenticates the human at its own edge, then
// forwards that identity to the agent as X-Asserted-Caller, where
// core-agent's existing per-caller ACLs (pkg/auth) apply. The agent
// credential lives only in this process — see proxy.go.
//
// Two Phase-1 modes, both of which put the identity on *every* request
// including the EventSource GET. That matters: EventSource cannot set
// headers, so any scheme requiring a client-supplied Authorization
// header cannot authenticate an SSE stream from a browser.
//
//	proxy-header — a fronting proxy has already authenticated the user
//	               and states who they are in a header. Only sound if
//	               that proxy strips client-supplied copies and this
//	               port is not directly reachable; unenforceable from
//	               in-process, hence the startup warning.
//	iap-jwt      — Google Identity-Aware Proxy. Same shape, but the
//	               assertion is a signed ES256 JWT we verify, so a
//	               client-supplied copy is not forgeable.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"

	"google.golang.org/api/idtoken"
)

// Auth mode names. Constants so flag parsing, /config, and tests agree
// on the exact strings.
const (
	authModeNone        = "none"
	authModeProxyHeader = "proxy-header"
	authModeIAPJWT      = "iap-jwt"
	// Reserved. parseFlags rejects it with a pointer to the phase that
	// implements it rather than a bare "unknown mode".
	authModeOIDC = "oidc"
)

const (
	// iapAssertionHeader is where Identity-Aware Proxy puts its signed
	// JWT. IAP strips any client-supplied copy before adding its own.
	iapAssertionHeader = "X-Goog-IAP-JWT-Assertion"
	// iapIssuer is the only `iss` an IAP assertion may carry. Checked
	// separately from idtoken.Validate, which verifies the signature
	// and `aud`/`exp` but not the issuer.
	iapIssuer = "https://cloud.google.com/iap"
	// assertedCallerHeader mirrors core-agent's auth.HeaderAssertedCaller.
	// The agent honors it only from a caller listed in proxy_identities.
	assertedCallerHeader = "X-Asserted-Caller"
)

// authenticator resolves the human behind a request. Identity returns
// ("", false) when the request carries no usable identity; withAuth
// decides what that means per route.
type authenticator interface {
	Identity(r *http.Request) (string, bool)
	Mode() string
}

// ─── noAuth ──────────────────────────────────────────────────────────

// noAuth is the today-behavior authenticator: every request passes with
// no identity. Kept as a real implementation rather than a nil check so
// /config and the middleware have one code path in every mode.
type noAuth struct{}

func (noAuth) Identity(*http.Request) (string, bool) { return "", true }
func (noAuth) Mode() string                          { return authModeNone }

// ─── headerAuth ──────────────────────────────────────────────────────

// headerAuth trusts an identity header set by a fronting proxy.
type headerAuth struct{ header string }

// Identity accepts the header only when it carries exactly one value.
//
// The startup warning says this mode is sound only if the fronting proxy
// strips client-supplied copies — but a proxy that *appends* its
// assertion rather than replacing it leaves the client's copy in front
// of its own, and Header.Get returns the first. That is silent
// impersonation of anyone the agent's proxy_identities allowlist trusts
// us to assert. Refusing an ambiguous header makes append-shaped proxies
// safe too, and costs nothing: a correct configuration sends one value.
//
// Not covered: a proxy that comma-joins into a single value. Go keeps
// separately-added headers separate, so that only happens if something
// in the chain deliberately folds them; an identity is still rejected
// downstream unless it happens to be a syntactically valid caller.
func (h headerAuth) Identity(r *http.Request) (string, bool) {
	vals := r.Header.Values(h.header)
	if len(vals) != 1 {
		if len(vals) > 1 {
			log.Printf("auth: %s carried %d values; refusing an ambiguous identity", h.header, len(vals))
		}
		return "", false
	}
	return validCaller(vals[0])
}

func (h headerAuth) Mode() string { return authModeProxyHeader }

// ─── iapJWTAuth ──────────────────────────────────────────────────────

// iapJWTAuth verifies a Google IAP assertion.
//
// validate is a field rather than a direct call to idtoken.Validate so
// tests can drive a validator wired to a fake JWKS endpoint. Verifying
// ES256 against Google's rotating key set is exactly the crypto not
// worth hand-rolling, so the real implementation is the library's.
type iapJWTAuth struct {
	audience string
	validate func(ctx context.Context, token, audience string) (*idtoken.Payload, error)
}

func (a iapJWTAuth) Identity(r *http.Request) (string, bool) {
	raw := strings.TrimSpace(r.Header.Get(iapAssertionHeader))
	if raw == "" {
		return "", false
	}
	payload, err := a.validate(r.Context(), raw, a.audience)
	if err != nil {
		log.Printf("auth: iap assertion rejected: %v", err)
		return "", false
	}
	if payload.Issuer != iapIssuer {
		log.Printf("auth: iap assertion rejected: issuer %q != %q", payload.Issuer, iapIssuer)
		return "", false
	}
	// IAP puts the human-readable identity in `email`; `sub` is the
	// opaque "accounts.google.com:<numeric id>" form. Prefer the email
	// so agent-side ACLs and audit logs name a person.
	if email, _ := payload.Claims["email"].(string); email != "" {
		return validCaller(email)
	}
	return validCaller(payload.Subject)
}

func (a iapJWTAuth) Mode() string { return authModeIAPJWT }

// ─── construction ────────────────────────────────────────────────────

// newAuthenticator builds the authenticator for cfg. The iap-jwt mode
// constructs its validator eagerly so a broken configuration fails at
// startup rather than on the first request; no network call happens
// until the first assertion needs a key.
func newAuthenticator(ctx context.Context, cfg config) (authenticator, error) {
	switch cfg.authMode {
	case "", authModeNone:
		return noAuth{}, nil
	case authModeProxyHeader:
		return headerAuth{header: cfg.authHeader}, nil
	case authModeIAPJWT:
		v, err := idtoken.NewValidator(ctx)
		if err != nil {
			return nil, fmt.Errorf("iap validator: %w", err)
		}
		return iapJWTAuth{audience: cfg.iapAudience, validate: v.Validate}, nil
	default:
		return nil, fmt.Errorf("unknown --auth-mode %q", cfg.authMode)
	}
}

// maxCallerLen bounds an identity. Emails and service-account names are
// far shorter; the cap exists so a hostile header can't be used to push
// an unbounded value into the agent's logs.
const maxCallerLen = 256

// validCaller normalizes and sanity-checks an identity before it is
// trusted. The value ends up on the outbound X-Asserted-Caller header,
// so anything outside printable ASCII is rejected rather than escaped —
// there is no legitimate identity that needs it, and a permissive
// filter here is a header-injection primitive pointed at the agent.
func validCaller(v string) (string, bool) {
	v = strings.TrimSpace(v)
	if v == "" || len(v) > maxCallerLen {
		return "", false
	}
	for i := 0; i < len(v); i++ {
		if v[i] < 0x20 || v[i] > 0x7e {
			return "", false
		}
	}
	return v, true
}

// ─── per-request identity ────────────────────────────────────────────

type ctxKeyRequestInfo struct{}

// requestInfo is a mutable per-request holder seeded by withLogging and
// filled in by withAuth.
//
// A holder rather than a plain context value because withLogging sits
// *outside* withAuth — so that a rejected request still produces an
// access-log line — and an outer wrapper cannot observe a context value
// added by an inner one. The proxy reads the same holder to build
// X-Asserted-Caller.
type requestInfo struct{ caller string }

func withRequestInfo(ctx context.Context) (context.Context, *requestInfo) {
	info := &requestInfo{}
	return context.WithValue(ctx, ctxKeyRequestInfo{}, info), info
}

func requestInfoFrom(ctx context.Context) *requestInfo {
	info, _ := ctx.Value(ctxKeyRequestInfo{}).(*requestInfo)
	return info
}

// ─── middleware ──────────────────────────────────────────────────────

// withAuth gates the handler on an authenticated identity.
//
// Three routes with three different failure shapes, and the difference
// is load-bearing:
//
//   - API paths get a 401 with a JSON body, never a redirect. fetch()
//     follows a 302 transparently, so a redirect would hand the SPA an
//     IdP login page to JSON.parse.
//   - Document navigations get a 401 too in Phase 1: proxy-header and
//     iap-jwt have no login route of their own (the fronting proxy owns
//     that), so redirecting would loop. Phase 3's oidc mode is where a
//     302 becomes correct.
//   - Everything else — the SPA's own scripts, styles, and vendored
//     bundles — is served unauthenticated. They hold no secrets, and
//     gating them is how you end up serving an IdP's HTML with a
//     Content-Type of application/javascript.
//
// Health probes and /config are exempt: kubelet does not carry an
// identity header, and the SPA has to be able to read /config in order
// to discover that it is unauthenticated.
func withAuth(authn authenticator, apiPrefix string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isAuthExempt(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		caller, ok := authn.Identity(r)
		if ok {
			if info := requestInfoFrom(r.Context()); info != nil {
				info.caller = caller
			}
			next.ServeHTTP(w, r)
			return
		}
		switch {
		case isAPIPath(r.URL.Path, apiPrefix):
			writeJSONError(w, http.StatusUnauthorized, "unauthenticated",
				"no verified caller identity on this request")
		case isDocumentRequest(r):
			http.Error(w, "unauthenticated: this deployment expects an upstream proxy "+
				"to authenticate the request and assert the caller's identity; none was found",
				http.StatusUnauthorized)
		default:
			next.ServeHTTP(w, r)
		}
	})
}

func isAuthExempt(p string) bool {
	switch p {
	case "/healthz", "/readyz", configPath:
		return true
	}
	return false
}

func isAPIPath(p, apiPrefix string) bool {
	if apiPrefix == "" {
		return false
	}
	return p == apiPrefix || strings.HasPrefix(p, apiPrefix+"/")
}

// isDocumentRequest reports whether the browser is navigating, as
// opposed to fetching a subresource. Sec-Fetch-Dest is authoritative
// where present (every browser that matters sends it); the Accept
// sniff is the fallback for curl and older clients.
func isDocumentRequest(r *http.Request) bool {
	if d := r.Header.Get("Sec-Fetch-Dest"); d != "" {
		return d == "document"
	}
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

// withCSRF is the inbound half of the CSRF story; proxy.go has the
// outbound half.
//
// It wraps the API prefix in every proxy-mode deployment, auth or no
// auth. An earlier draft mounted it only when auth was enabled, on the
// reasoning that auth-mode=none has no *ambient* credential to forge
// with because the SPA attaches its token from JavaScript. That
// reasoning does not survive BACKEND_TOKEN: in that shape the server
// stamps the credential onto every proxied request, so the credential
// is ambient to anyone who can reach the port, whoever they are.
//
// Nothing was actually exploitable — proxy.go strips Origin, but the
// agent's own guard rejects any write without a JSON Content-Type
// regardless of Origin, and a cross-origin JSON write preflights
// against a backend that answers no CORS headers. But that left the
// only remaining check in a different repo, one this proxy has already
// half-disarmed. Mounting the guard unconditionally costs nothing (every
// working client already sends JSON; a missing Origin is still allowed
// for curl and CI) and removes the coupling.
//
// The rules mirror core-agent's browserWriteGuard (pkg/attach/csrf.go)
// because the BFF has taken over that job: proxy.go strips Origin on
// the way out, so the agent sees a native client and its Origin check
// no longer fires. Its Content-Type check still does.
//
//   - Writes must carry Content-Type: application/json. An HTML form
//     can only send urlencoded, multipart, or text/plain, so this alone
//     defeats form-based CSRF; a cross-origin fetch() with a JSON body
//     triggers a preflight we never answer.
//   - A present Origin must match this deployment. Absent is allowed:
//     non-browser clients (curl, CI) legitimately send none.
func withCSRF(externalOrigin string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if !isJSONContentType(r.Header.Get("Content-Type")) {
			writeJSONError(w, http.StatusUnsupportedMediaType, "unsupported_media_type",
				"writes must carry Content-Type: application/json")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !originAllowed(origin, externalOrigin, r.Host) {
			writeJSONError(w, http.StatusForbidden, "forbidden_origin",
				"request Origin is not this deployment")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// isJSONContentType accepts "application/json" with any parameters
// ("; charset=utf-8") and rejects everything else.
func isJSONContentType(v string) bool {
	if v == "" {
		return false
	}
	if i := strings.IndexByte(v, ';'); i >= 0 {
		v = v[:i]
	}
	return strings.EqualFold(strings.TrimSpace(v), "application/json")
}

// originAllowed compares a browser-supplied Origin against the
// deployment. Two ways to pass:
//
//   - it exactly matches --external-url, scheme included; or
//   - its host matches the request's own Host, i.e. the page that sent
//     it was served by this deployment at the address it was asked for.
//
// The second is what makes a same-origin write same-origin, and it has
// to hold even when --external-url names some other hostname: one
// deployment is routinely reachable at more than one name (a public LB,
// internal service DNS, a per-port dev-environment hostname), and a
// same-origin request is by definition not cross-site forgery. An
// attacking page satisfies neither branch — the browser stamps ITS
// origin on the request, not ours.
//
// Scheme is deliberately not compared in the Host branch: behind a
// TLS-terminating proxy the browser's origin is https while this
// process only ever sees http, so the host match is the meaningful
// part. That mirrors core-agent's own originAllowed.
func originAllowed(origin, externalOrigin, host string) bool {
	if externalOrigin != "" && strings.EqualFold(strings.TrimRight(origin, "/"), externalOrigin) {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false // includes "null" and unparseable values
	}
	return strings.EqualFold(u.Host, host)
}

// writeJSONError emits the error shape the SPA's attach-core client
// already understands. Always JSON — API callers must never have to
// guess whether a body is JSON or an HTML error page.
func writeJSONError(w http.ResponseWriter, status int, code, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error":  code,
		"detail": detail,
	})
}
