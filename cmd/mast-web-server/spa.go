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
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// spaHandler serves the web tree from staticFS. There is no single
// shell document to route to: since #61 the entry points are
// solo.html and spatial.html, and web/index.html is a 37-line
// redirect that picks between them. Unknown paths without a file
// extension fall back to "/" — and so to that redirect — rather than
// 404ing on what looks like a client-side route; known assets that
// don't exist 404 cleanly through http.FileServer.
//
// "/" is served by http.FileServer's own index.html lookup rather than
// by a rewrite here, because the tarball and static-host deployment
// shapes have no Go server to rewrite with. The chooser has to be a
// real file with that name for those to work at all.
//
// Also disables browser caching so a dev iterating on web/*.js with
// --web-dir sees reloads pick up edits without a hard-reload dance.
// Production containers ship a versioned tag so cache-busting isn't
// needed at the CDN layer either.
//
// Security headers: every document under web/ carries its own <meta>
// CSP so the policy travels with the tarball / static-host shapes too,
// but browsers ignore frame-ancestors (and sandbox / report-uri) in
// meta. Those only bind as real headers, so anti-framing is set here.
func spaHandler(staticFS fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(staticFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		// Clickjacking: an operator console that can drive an agent
		// must never be framable. X-Frame-Options is the legacy
		// spelling kept for older browsers; CSP is authoritative.
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")

		clean := path.Clean(r.URL.Path)
		if clean == "/" {
			fileServer.ServeHTTP(w, r)
			return
		}
		// Extensionless path → try SPA-route fallback.
		if path.Ext(clean) == "" {
			_, err := fs.Stat(staticFS, strings.TrimPrefix(clean, "/"))
			if err != nil {
				r2 := r.Clone(r.Context())
				r2.URL.Path = "/"
				fileServer.ServeHTTP(w, r2)
				return
			}
		}
		fileServer.ServeHTTP(w, r)
	})
}
