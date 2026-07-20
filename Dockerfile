# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Multi-stage build for ghcr.io/go-steer/mast-web:
#
#   asset-stage  — build the SPA bundle (web/ -> internal/webui/dist/)
#   go-stage     — compile mast-web-server with the embedded bundle
#   runtime      — distroless static, ~10MB, runs as nonroot

# ── asset-stage ───────────────────────────────────────────────────────
FROM node:20-alpine AS asset-stage
WORKDIR /src

# Copy only what the asset build needs to maximize layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web/ ./web/
# v0.1: vanilla JS with no transpile/bundle step — populate the embed
# location directly from web/. When the build pipeline grows real
# bundling (esbuild / vite / etc.) per docs/web-design.md's stack
# decisions, replace this with the proper invocation.
RUN mkdir -p internal/webui/dist && cp -R web/. internal/webui/dist/

# ── go-stage ───────────────────────────────────────────────────────────
FROM golang:1.26-alpine AS go-stage
WORKDIR /src

# Module deps first for layer caching.
COPY go.mod ./
# No go.sum yet — stdlib-only module. Add COPY go.sum ./ when external deps land.
RUN go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/
# The embed source has to be present at compile time — pull from the
# asset stage. Path matches //go:embed all:dist in internal/webui/webui.go.
COPY --from=asset-stage /src/internal/webui/dist/ ./internal/webui/dist/

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" \
    -o /out/mast-web-server ./cmd/mast-web-server

# ── runtime ────────────────────────────────────────────────────────────
FROM gcr.io/distroless/static:nonroot
COPY --from=go-stage /out/mast-web-server /mast-web-server

USER 65532:65532
EXPOSE 8080

# Default environment — operator overrides via `docker run -e`.
ENV LISTEN=:8080 \
    API_PREFIX=/attach

# No HEALTHCHECK directive — distroless images don't ship wget/curl, and
# adding a probe binary defeats the size goal. K8s / Cloud Run hit the
# server's /healthz endpoint directly via their own probe config.

ENTRYPOINT ["/mast-web-server"]
