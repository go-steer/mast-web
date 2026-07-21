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

// spaHandler serves the SPA from staticFS. Unknown paths without a
// file extension fall back to index.html so a hypothetical SPA with
// client-side routing still lands on the shell; known assets that
// don't exist 404 cleanly through http.FileServer.
//
// Also disables browser caching so a dev iterating on web/*.js with
// --web-dir sees reloads pick up edits without a hard-reload dance.
// Production containers ship a versioned tag so cache-busting isn't
// needed at the CDN layer either.
func spaHandler(staticFS fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(staticFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

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
