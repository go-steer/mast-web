# mast-web

Operator-facing web UI for [mast](https://github.com/go-steer/mast) and any [attach-mode](https://github.com/go-steer/core-agent/blob/main/docs/attach-mode-design.md)-compatible [core-agent](https://github.com/go-steer/core-agent) variant. Thin client over the attach protocol; no agent loop in the browser.

**📚 Full documentation: [go-steer.github.io/mast-web](https://go-steer.github.io/mast-web/)** *(deploys after first push to main)*

[![CI](https://github.com/go-steer/mast-web/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/go-steer/mast-web/actions/workflows/ci.yml)
[![Docs](https://github.com/go-steer/mast-web/actions/workflows/docs.yml/badge.svg?branch=main)](https://go-steer.github.io/mast-web/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

> **Status:** pre-alpha. The repo is being bootstrapped phase-by-phase per [`docs/web-bootstrap.md`](./docs/web-bootstrap.md). Phase A (UI port from cogo-wasm2) ships first; phase B wires the attach-protocol client; phase C adds the release pipeline. Architecture in [`docs/web-design.md`](./docs/web-design.md).

---

## Why a web UI

`mast` (and core-agent) is fundamentally a backend agent process — it runs in a Cloud Run pod, a Kubernetes service, or a daemon container, where all the load-bearing infrastructure (MCP servers, K8s context, credentials, audit log, cost ceilings, shared memory, watchdog) lives. The interactive surface is *"operator drops in remotely to check progress, give a new task, verify a hypothesis"* — a use case better served by a browser than a terminal:

- No client installation (browse to URL)
- Aligns with cloud-native deployment shape (HTTP-native)
- Multi-operator-friendly out of the box
- Auth integration with SSO / OIDC / IAP / mTLS via the attach mode's existing auth paths
- Richer rendering primitives (syntax highlighting, collapsible tool calls, streaming, plan-first plan rendering, watchdog alerts)
- Mobile-viable for at-a-glance status checks

The terminal-TUI use case (developer iterating on agent design locally) is better served by [`core-tui`](https://github.com/go-steer/core-tui). `mast-web` doesn't try to be both products.

---

## Architectural pattern

```
┌──────────────┐   SSE / POST       ┌──────────────────────┐    HTTP/MCP    ┌──────────────────┐
│  mast-web    │ ◄────────────────► │  mast (Cloud Run /   │ ◄────────────► │  Vertex / MCP    │
│  (browser)   │   attach protocol  │  K8s / daemon)       │                │  servers / K8s   │
│              │                    │                      │                │                  │
│  - Chat UI   │                    │  - Agent loop        │                │                  │
│  - Tool call │                    │  - Tool execution    │                │                  │
│    render    │                    │  - MCP integration   │                │                  │
│  - Streaming │                    │  - Audit log         │                │                  │
│  - Sidebar   │                    │  - Cost ceilings     │                │                  │
│  - Status    │                    │  - Watchdog          │                │                  │
└──────────────┘                    │  - Shared memory     │                └──────────────────┘
                                    └──────────────────────┘
```

The browser renders; the backend does everything else. See [`docs/web-design.md`](./docs/web-design.md) for the full architectural rationale, including why this differs from the [cogo-wasm2](https://github.com/mastersingh24/cogo-wasm2) pattern (browser-WASM-as-agent + auth proxy) — that pattern fits cogo's job, but is structurally wrong for `mast`.

---

## Quickstart *(once phase A lands)*

```bash
# 1. Run a core-agent (or mast) backend with attach mode enabled
core-agent --attach-listen :7777 --session-db

# 2. In another terminal, serve the web UI
make dev

# 3. Browse to http://localhost:8000 and connect to http://localhost:7777
```

## Deployment options

Four ways to deploy mast-web, in increasing order of operator control:

| Path | Command | Best for |
|---|---|---|
| **Hosted SPA** | Visit `https://go-steer.github.io/mast-web/app/` *(coming soon)* | "Just let me try mast" |
| **Container image** | `docker run -p 8080:8080 -e BACKEND_URL=http://core-agent:7777 ghcr.io/go-steer/mast-web:latest` | Production K8s / Cloud Run / Docker Compose |
| **Agent `--ui` flag** *(planned)* | `core-agent --attach-listen :7777 --ui` then visit `:7777/ui/` | Single-binary deploys, air-gapped, local dev |
| **Tarball + your own host** | `tar -xzf mast-web-v0.1.0.tar.gz && nginx -s reload` | Custom CDN, strict hosting requirements |

The container image bundles a tiny Go static-file server with the SPA and optionally **proxies attach calls to a configured backend** — eliminating CORS as a concern because the browser only ever talks to same-origin URLs. Configuration via env vars:

| Env | Default | Purpose |
|---|---|---|
| `LISTEN` | `:8080` | Bind address |
| `BACKEND_URL` | — | Optional reverse-proxy target; SPA hits `/attach/*` same-origin |
| `API_PREFIX` | `/attach` | URL prefix routed to the backend proxy |
| `BACKEND_TOKEN` | — | If set, the server injects `Authorization: Bearer <token>` into proxied requests; SPA carries no auth |

---

## Project layout

```
mast-web/
├── web/                    # the SPA (HTML/CSS/JS)
├── docs/                   # design docs + Hugo site
│   └── site/               # Hugo (Docsy theme)
├── dev/                    # build/test/lint tooling (matches go-steer convention)
│   ├── ci/presubmits/      # CI delegators
│   └── tools/              # actual logic
├── dist/                   # build output (gitignored)
└── .github/workflows/      # CI/CD
```

---

## Related

- [mast](https://github.com/go-steer/mast) — the agent runtime this UI talks to (post-fork; until then, [core-agent](https://github.com/go-steer/core-agent) works equivalently)
- [core-agent](https://github.com/go-steer/core-agent) — the parent project from which mast forks
- [core-tui](https://github.com/go-steer/core-tui) — terminal TUI alternative for developer/experimentation workflows
- [cogo-wasm2](https://github.com/mastersingh24/cogo-wasm2) — the project this borrows rendering surface from

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).
