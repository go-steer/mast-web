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
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"google.golang.org/api/idtoken"
	"google.golang.org/api/option"
)

// ─── validCaller ─────────────────────────────────────────────────────

func TestValidCaller(t *testing.T) {
	tests := []struct {
		name  string
		in    string
		want  string
		wantK bool
	}{
		{"plain email", "alice@example.com", "alice@example.com", true},
		{"trims surrounding space", "  alice@example.com \t", "alice@example.com", true},
		{"service account form", "sa:mast-web", "sa:mast-web", true},
		{"empty", "", "", false},
		{"whitespace only", "   ", "", false},
		// A header value carrying a newline is a smuggling primitive
		// pointed at the agent's X-Asserted-Caller.
		{"embedded newline", "alice\nX-Asserted-Caller: root", "", false},
		{"embedded CR", "alice\rroot", "", false},
		{"NUL byte", "alice\x00root", "", false},
		{"non-ascii", "alicé@example.com", "", false},
		{"over length cap", strings.Repeat("a", maxCallerLen+1), "", false},
		{"at length cap", strings.Repeat("a", maxCallerLen), strings.Repeat("a", maxCallerLen), true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := validCaller(tc.in)
			if got != tc.want || ok != tc.wantK {
				t.Fatalf("validCaller(%q) = (%q, %v), want (%q, %v)", tc.in, got, ok, tc.want, tc.wantK)
			}
		})
	}
}

// ─── headerAuth ──────────────────────────────────────────────────────

func TestHeaderAuth(t *testing.T) {
	a := headerAuth{header: "X-Test-User"}
	if a.Mode() != authModeProxyHeader {
		t.Fatalf("Mode() = %q", a.Mode())
	}

	r := httptest.NewRequest("GET", "/", nil)
	if _, ok := a.Identity(r); ok {
		t.Fatal("want unauthenticated with no header")
	}

	r.Header.Set("X-Test-User", "alice@example.com")
	got, ok := a.Identity(r)
	if !ok || got != "alice@example.com" {
		t.Fatalf("Identity() = (%q, %v)", got, ok)
	}

	// A different header name must not be honored — the configured one
	// is the only trusted channel.
	r2 := httptest.NewRequest("GET", "/", nil)
	r2.Header.Set("X-Forwarded-User", "mallory@example.com")
	if _, ok := a.Identity(r2); ok {
		t.Fatal("want unauthenticated for an unconfigured header")
	}
}

func TestHeaderAuth_RejectsAmbiguousDuplicateHeader(t *testing.T) {
	// A fronting proxy that APPENDS its assertion instead of replacing
	// leaves the client's copy first, and Header.Get takes the first —
	// so the naive read hands an attacker any identity they like.
	// Ambiguity is refused outright rather than resolved by position:
	// "last wins" would be just as much a guess about the proxy as
	// "first wins", and guessing wrong is silent impersonation.
	a := headerAuth{header: "X-Test-User"}

	for _, order := range [][2]string{
		{"attacker@evil.example", "alice@example.com"}, // proxy appended
		{"alice@example.com", "attacker@evil.example"}, // proxy prepended
	} {
		r := httptest.NewRequest("GET", "/attach/sessions", nil)
		r.Header.Add("X-Test-User", order[0])
		r.Header.Add("X-Test-User", order[1])
		if got, ok := a.Identity(r); ok {
			t.Errorf("values %v: authenticated as %q; want refused", order, got)
		}
	}
}

// ─── iapJWTAuth ──────────────────────────────────────────────────────
//
// These drive the real google.golang.org/api/idtoken validator against
// an in-test ECDSA key and a fake JWKS endpoint, so the signature,
// audience, expiry and algorithm checks exercised here are the ones
// that run in production.

const iapJWKSURL = "https://www.gstatic.com/iap/verify/public_key-jwk"

const testKID = "test-kid"

// jwksTransport answers the IAP key-set URL with a fixed body and
// fails loudly on any other request, so a test can never accidentally
// reach the real internet.
type jwksTransport struct{ body []byte }

func (t jwksTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.String() != iapJWKSURL {
		return nil, fmt.Errorf("unexpected outbound request to %s", r.URL)
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(bytes.NewReader(t.body)),
		Request:    r,
	}, nil
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// newIAPValidator builds a Validator whose key set contains exactly the
// public half of key, published under kid.
func newIAPValidator(t *testing.T, key *ecdsa.PrivateKey, kid string) *idtoken.Validator {
	t.Helper()
	jwks, err := json.Marshal(map[string]any{
		"keys": []map[string]string{{
			"kty": "EC",
			"crv": "P-256",
			"alg": "ES256",
			"use": "sig",
			"kid": kid,
			"x":   b64(key.PublicKey.X.Bytes()),
			"y":   b64(key.PublicKey.Y.Bytes()),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	v, err := idtoken.NewValidator(context.Background(),
		option.WithHTTPClient(&http.Client{Transport: jwksTransport{body: jwks}}))
	if err != nil {
		t.Fatalf("NewValidator: %v", err)
	}
	return v
}

// signES256 mints a JWT signed with key. alg and kid are parameters so
// the negative cases can lie about them.
func signES256(t *testing.T, key *ecdsa.PrivateKey, alg, kid string, claims map[string]any) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": alg, "typ": "JWT", "kid": kid})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	signing := b64(header) + "." + b64(payload)
	sum := sha256.Sum256([]byte(signing))

	switch alg {
	case "none":
		return signing + "."
	case "HS256":
		mac := hmac.New(sha256.New, []byte("symmetric-key"))
		mac.Write([]byte(signing))
		return signing + "." + b64(mac.Sum(nil))
	}

	r, s, err := ecdsa.Sign(rand.Reader, key, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	// ES256 signatures are the fixed-width r‖s concatenation, not the
	// ASN.1 form ecdsa.SignASN1 produces.
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return signing + "." + b64(sig)
}

func iapClaims(aud string) map[string]any {
	return map[string]any{
		"iss":   iapIssuer,
		"aud":   aud,
		"exp":   time.Now().Add(time.Hour).Unix(),
		"iat":   time.Now().Add(-time.Minute).Unix(),
		"sub":   "accounts.google.com:1234567890",
		"email": "alice@example.com",
	}
}

func newTestKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func TestIAPJWTAuth_AcceptsValidAssertion(t *testing.T) {
	key := newTestKey(t)
	const aud = "/projects/1/global/backendServices/2"
	a := iapJWTAuth{audience: aud, validate: newIAPValidator(t, key, testKID).Validate}

	r := httptest.NewRequest("GET", "/attach/sessions", nil)
	r.Header.Set(iapAssertionHeader, signES256(t, key, "ES256", testKID, iapClaims(aud)))

	got, ok := a.Identity(r)
	if !ok {
		t.Fatal("want authenticated")
	}
	// The email claim, not the opaque accounts.google.com subject —
	// the agent's ACLs and audit log should name a person.
	if got != "alice@example.com" {
		t.Fatalf("Identity() = %q, want alice@example.com", got)
	}
}

func TestIAPJWTAuth_FallsBackToSubjectWithoutEmail(t *testing.T) {
	key := newTestKey(t)
	const aud = "aud-1"
	claims := iapClaims(aud)
	delete(claims, "email")
	a := iapJWTAuth{audience: aud, validate: newIAPValidator(t, key, testKID).Validate}

	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set(iapAssertionHeader, signES256(t, key, "ES256", testKID, claims))

	got, ok := a.Identity(r)
	if !ok || got != "accounts.google.com:1234567890" {
		t.Fatalf("Identity() = (%q, %v)", got, ok)
	}
}

func TestIAPJWTAuth_Rejects(t *testing.T) {
	key := newTestKey(t)
	otherKey := newTestKey(t)
	const aud = "aud-1"

	expired := iapClaims(aud)
	expired["exp"] = time.Now().Add(-time.Minute).Unix()

	wrongIssuer := iapClaims(aud)
	wrongIssuer["iss"] = "https://accounts.google.com"

	tests := []struct {
		name  string
		token string
	}{
		{"missing header", ""},
		{"not a jwt", "garbage"},
		{"unknown kid", signES256(t, key, "ES256", "other-kid", iapClaims(aud))},
		{"signed by a different key", signES256(t, otherKey, "ES256", testKID, iapClaims(aud))},
		{"wrong audience", signES256(t, key, "ES256", testKID, iapClaims("someone-elses-service"))},
		{"expired", signES256(t, key, "ES256", testKID, expired)},
		// alg confusion: an unsigned token and a symmetric one must not
		// be accepted just because the claims look right.
		{"alg none", signES256(t, key, "none", testKID, iapClaims(aud))},
		{"alg HS256", signES256(t, key, "HS256", testKID, iapClaims(aud))},
		// Signature is valid but the token was not minted by IAP.
		{"wrong issuer", signES256(t, key, "ES256", testKID, wrongIssuer)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a := iapJWTAuth{audience: aud, validate: newIAPValidator(t, key, testKID).Validate}
			r := httptest.NewRequest("GET", "/", nil)
			if tc.token != "" {
				r.Header.Set(iapAssertionHeader, tc.token)
			}
			if got, ok := a.Identity(r); ok {
				t.Fatalf("want rejected, got authenticated as %q", got)
			}
		})
	}
}

// ─── withAuth ────────────────────────────────────────────────────────

// echoCaller reports the caller withAuth stashed for this request, so a
// test can assert the identity actually reached downstream handlers.
func echoCaller() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		caller := ""
		if info := requestInfoFrom(r.Context()); info != nil {
			caller = info.caller
		}
		_, _ = io.WriteString(w, "downstream caller="+caller)
	})
}

// serveWithAuth runs one request through withLogging(withAuth(...)),
// matching how buildMux composes them — withLogging must be outermost
// because it seeds the requestInfo holder.
func serveWithAuth(authn authenticator, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	withLogging(withAuth(authn, "/attach", echoCaller())).ServeHTTP(w, r)
	return w
}

func TestWithAuth_PassesAuthenticatedRequestAndSetsCaller(t *testing.T) {
	r := httptest.NewRequest("GET", "/attach/sessions", nil)
	r.Header.Set("X-Test-User", "alice@example.com")

	w := serveWithAuth(headerAuth{header: "X-Test-User"}, r)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", w.Code)
	}
	if got := w.Body.String(); got != "downstream caller=alice@example.com" {
		t.Fatalf("caller did not reach downstream: %q", got)
	}
}

func TestWithAuth_APIPathGets401JSONNotARedirect(t *testing.T) {
	// A 302 here would be a real bug: fetch() follows redirects
	// transparently, so the SPA would JSON.parse a login page.
	r := httptest.NewRequest("GET", "/attach/sessions", nil)
	w := serveWithAuth(headerAuth{header: "X-Test-User"}, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("want JSON body, got Content-Type %q", ct)
	}
	if loc := w.Header().Get("Location"); loc != "" {
		t.Fatalf("want no redirect, got Location %q", loc)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%q)", err, w.Body.String())
	}
	if body["error"] != "unauthenticated" {
		t.Fatalf("want error=unauthenticated, got %v", body)
	}
}

func TestWithAuth_DocumentNavigationIsRejectedNotRedirected(t *testing.T) {
	// proxy-header and iap-jwt have no login route of their own; a 302
	// would loop. Phase 3's oidc mode is where a redirect is correct.
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Sec-Fetch-Dest", "document")
	r.Header.Set("Accept", "text/html")

	w := serveWithAuth(headerAuth{header: "X-Test-User"}, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", w.Code)
	}
	if loc := w.Header().Get("Location"); loc != "" {
		t.Fatalf("want no redirect, got Location %q", loc)
	}
}

func TestWithAuth_SubresourcesAreServedUnauthenticated(t *testing.T) {
	// SPA assets hold no secrets, and gating them is how a deployment
	// ends up serving an IdP's HTML with a JavaScript Content-Type.
	for _, dest := range []string{"script", "style", "font", "image"} {
		t.Run(dest, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/app.js", nil)
			r.Header.Set("Sec-Fetch-Dest", dest)
			w := serveWithAuth(headerAuth{header: "X-Test-User"}, r)
			if w.Code != http.StatusOK {
				t.Fatalf("want 200 for %s subresource, got %d", dest, w.Code)
			}
			if got := w.Body.String(); got != "downstream caller=" {
				t.Fatalf("want anonymous passthrough, got %q", got)
			}
		})
	}
}

func TestWithAuth_ExemptPaths(t *testing.T) {
	// kubelet does not carry an identity header. This list is the whole
	// anonymous surface of the server, which is why it is short.
	for _, p := range []string{"/healthz", "/readyz"} {
		t.Run(p, func(t *testing.T) {
			r := httptest.NewRequest("GET", p, nil)
			r.Header.Set("Sec-Fetch-Dest", "document")
			w := serveWithAuth(headerAuth{header: "X-Test-User"}, r)
			if w.Code != http.StatusOK {
				t.Fatalf("want 200 for exempt path %s, got %d", p, w.Code)
			}
		})
	}
}

func TestWithAuth_ConfigIsNotAnonymous(t *testing.T) {
	// /config describes the deployment — API prefix, mode, auth mode —
	// and a stranger has no business reading it. The subresource branch
	// makes this worth a test of its own: /config is neither a document
	// nor under the API prefix, so without naming it explicitly it would
	// fall through to the anonymous passthrough that serves app.js.
	//
	// Fetched, not navigated: the failure has to be JSON, since the SPA
	// reads it with fetch() and would otherwise JSON.parse a login page.
	for _, dest := range []string{"empty", "document"} {
		t.Run(dest, func(t *testing.T) {
			r := httptest.NewRequest("GET", configPath, nil)
			r.Header.Set("Sec-Fetch-Dest", dest)
			w := serveWithAuth(headerAuth{header: "X-Test-User"}, r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("want 401, got %d (%q)", w.Code, w.Body.String())
			}
			if loc := w.Header().Get("Location"); loc != "" {
				t.Fatalf("want no redirect, got Location %q", loc)
			}
			var body map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("body is not JSON: %v (%q)", err, w.Body.String())
			}
			if body["error"] != "unauthenticated" {
				t.Fatalf("want error=unauthenticated, got %v", body)
			}
		})
	}
}

func TestWithAuth_ConfigIsServedToAVerifiedCaller(t *testing.T) {
	// The gate is on anonymity, not on /config: the SPA that has already
	// cleared auth for its document must still be able to bootstrap.
	r := httptest.NewRequest("GET", configPath, nil)
	r.Header.Set("X-Test-User", "alice@example.com")
	w := serveWithAuth(headerAuth{header: "X-Test-User"}, r)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%q)", w.Code, w.Body.String())
	}
}

func TestIsAPIPath(t *testing.T) {
	tests := []struct {
		path, prefix string
		want         bool
	}{
		{"/attach/sessions", "/attach", true},
		{"/attach", "/attach", true},
		{"/attach/", "/attach", true},
		// Must not match a sibling path that merely shares a prefix.
		{"/attachment", "/attach", false},
		{"/", "/attach", false},
		{"/app.js", "/attach", false},
		{"/attach/sessions", "", false},
	}
	for _, tc := range tests {
		if got := isAPIPath(tc.path, tc.prefix); got != tc.want {
			t.Errorf("isAPIPath(%q, %q) = %v, want %v", tc.path, tc.prefix, got, tc.want)
		}
	}
}

// ─── withCSRF ────────────────────────────────────────────────────────

func serveWithCSRF(externalOrigin string, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	withCSRF(externalOrigin, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	})).ServeHTTP(w, r)
	return w
}

func TestWithCSRF_ReadsPassThrough(t *testing.T) {
	for _, m := range []string{http.MethodGet, http.MethodHead, http.MethodOptions} {
		r := httptest.NewRequest(m, "/attach/sessions", nil)
		r.Header.Set("Origin", "https://evil.example")
		if w := serveWithCSRF("", r); w.Code != http.StatusOK {
			t.Fatalf("%s: want 200, got %d", m, w.Code)
		}
	}
}

func TestWithCSRF_WritesRequireJSONContentType(t *testing.T) {
	// An HTML form can only send these three; requiring JSON is what
	// makes form-based CSRF impossible without a preflight.
	for _, ct := range []string{"", "application/x-www-form-urlencoded", "multipart/form-data", "text/plain"} {
		r := httptest.NewRequest(http.MethodPost, "/attach/sessions", strings.NewReader("{}"))
		if ct != "" {
			r.Header.Set("Content-Type", ct)
		}
		if w := serveWithCSRF("", r); w.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("Content-Type %q: want 415, got %d", ct, w.Code)
		}
	}

	for _, ct := range []string{"application/json", "application/json; charset=utf-8", "APPLICATION/JSON"} {
		r := httptest.NewRequest(http.MethodPost, "/attach/sessions", strings.NewReader("{}"))
		r.Header.Set("Content-Type", ct)
		if w := serveWithCSRF("", r); w.Code != http.StatusOK {
			t.Fatalf("Content-Type %q: want 200, got %d", ct, w.Code)
		}
	}
}

func TestWithCSRF_OriginCheck(t *testing.T) {
	tests := []struct {
		name           string
		externalOrigin string
		origin         string
		want           int
	}{
		{"absent origin is allowed (curl, CI)", "", "", http.StatusOK},
		{"same host as the request", "", "http://example.com", http.StatusOK},
		{"foreign host", "", "https://evil.example", http.StatusForbidden},
		{"external-url exact match", "https://mast.example.com", "https://mast.example.com", http.StatusOK},
		// A downgraded origin doesn't match --external-url, and its
		// host isn't the request's either, so neither branch saves it.
		{"external-url scheme mismatch", "https://mast.example.com", "http://mast.example.com", http.StatusForbidden},
		{"external-url host mismatch", "https://mast.example.com", "https://evil.example", http.StatusForbidden},
		// Configuring --external-url must not break the same-origin
		// case. One deployment is routinely reachable at more than one
		// hostname — a public LB, internal service DNS, a per-port
		// Cloud Workstations / Codespaces host — and a page served at
		// the address the request was addressed to is not cross-site.
		{"same-origin request despite a different external-url", "https://mast.example.com", "https://example.com", http.StatusOK},
		// "null" is what a sandboxed iframe or a data: document sends.
		{"null origin", "", "null", http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "http://example.com/attach/sessions", strings.NewReader("{}"))
			r.Host = "example.com"
			r.Header.Set("Content-Type", "application/json")
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			if w := serveWithCSRF(tc.externalOrigin, r); w.Code != tc.want {
				t.Fatalf("want %d, got %d", tc.want, w.Code)
			}
		})
	}
}

func TestIsJSONContentType(t *testing.T) {
	tests := map[string]bool{
		"application/json":                  true,
		"application/json; charset=utf-8":   true,
		" application/json ":                true,
		"Application/JSON":                  true,
		"":                                  false,
		"text/json":                         false,
		"application/jsonx":                 false,
		"application/x-www-form-urlencoded": false,
	}
	for in, want := range tests {
		if got := isJSONContentType(in); got != want {
			t.Errorf("isJSONContentType(%q) = %v, want %v", in, got, want)
		}
	}
}
