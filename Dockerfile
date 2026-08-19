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
#
# Multi-arch cross-compile:
#   Both intermediate stages are pinned to $BUILDPLATFORM so they run
#   NATIVELY on the CI amd64 runner (npm ci + go build are fast). The
#   go build cross-compiles to $TARGETARCH so the final binary matches
#   the runtime layer's architecture. buildx's `--platform linux/amd64,
#   linux/arm64` then only needs QEMU for the final scratch-based
#   runtime layer, which does zero code execution — just file copies.
#
#   Fix for mast-web#29: previously both intermediates inherited the
#   target platform, forcing full QEMU emulation of npm ci + go build,
#   which stalled the arm64 leg indefinitely (~6h, then cancelled).

# ── asset-stage ───────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:24-alpine AS asset-stage
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
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS go-stage
WORKDIR /src

# Module deps first for layer caching.
COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/
# The embed source has to be present at compile time — pull from the
# asset stage. Path matches //go:embed all:dist in internal/webui/webui.go.
COPY --from=asset-stage /src/internal/webui/dist/ ./internal/webui/dist/

# buildx populates $TARGETARCH per platform (amd64 / arm64 / etc.);
# cross-compile to it from the native amd64 host. CGO stays off so
# there's no linker toolchain dependency.
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" \
    -o /out/mast-web-server ./cmd/mast-web-server

# ── runtime ────────────────────────────────────────────────────────────
# Distroless picks the correct-arch base automatically from buildx's
# per-target --platform; the COPY below then lands the arch-matching
# binary produced by go-stage. No execution in this layer.
FROM gcr.io/distroless/static:nonroot
COPY --from=go-stage /out/mast-web-server /mast-web-server

USER 65532:65532
EXPOSE 8080

# Default environment — operator overrides via `docker run -e`.
#
# AUTH_MODE is spelled out rather than left implicit: with BACKEND_URL set
# this container is a credentialed path to the agent, and `none` means
# every caller who can reach the port shares one identity. A hosted,
# multi-user deployment wants AUTH_MODE=iap-jwt (plus IAP_AUDIENCE) or
# proxy-header (plus AUTH_HEADER) — see docs/site/content/docs/deployment.md.
# The server warns loudly at startup if it ends up open and non-loopback.
ENV LISTEN=:8080 \
    API_PREFIX=/attach \
    AUTH_MODE=none

# No HEALTHCHECK directive — distroless images don't ship wget/curl, and
# adding a probe binary defeats the size goal. K8s / Cloud Run hit the
# server's /healthz endpoint directly via their own probe config.

ENTRYPOINT ["/mast-web-server"]
