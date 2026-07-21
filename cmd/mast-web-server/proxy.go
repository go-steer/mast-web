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
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// newBackendProxy builds a httputil.ReverseProxy for the attach API.
// FlushInterval=-1 is essential — without it the proxy buffers SSE
// frames and the SPA never sees real-time updates.
//
// When injectedToken is non-empty, the proxy overwrites the operator's
// Authorization + X-Attach-Token headers with the server-side token.
// This is the "shared backend, single auth" pattern where the SPA
// carries no auth material (BACKEND_TOKEN mode). When empty, whatever
// the SPA sent flows through untouched (per-operator token mode).
func newBackendProxy(rawURL, injectedToken string) (*httputil.ReverseProxy, error) {
	target, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse backend URL %q: %w", rawURL, err)
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, fmt.Errorf("backend URL must be http(s); got %q", target.Scheme)
	}

	rp := &httputil.ReverseProxy{
		// Flush immediately on each chunk — required for SSE.
		FlushInterval: -1,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.SetXForwarded()
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
