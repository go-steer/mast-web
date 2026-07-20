# mast-web: design

**Status:** living, last reconciled 2026-07-20 (evening). Migrated from `core-agent/docs/mast/web-design.md` on 2026-06-12 as part of mast-web repo init. Substantively revised 2026-06-13: dropped "go:embed into the agent binary" as the *default* deployment shape — the actual answer is a spectrum of four operator-selectable options (hosted SPA, container image, agent `--ui` flag, self-host tarball). Reconciled 2026-07-20: bumped protocol version references from v1.1.0 through v1.4.0 (v1.3.0 was consumed by the digest-`savings` sidecar; v1.4.0 added the capability manifest per core-agent#344 + core-tui#68), flipped Phase C★ to Shipped, redirected mast docs cross-refs to the mast repo (which now exists as docs-only pre-code-fork). Companion to [fork-design.md](https://github.com/go-steer/mast/blob/main/docs/fork-design.md) (which specifies `mast` as the lean-fork project) and [positioning.md](https://github.com/go-steer/mast/blob/main/docs/positioning.md) (the thesis). Live v0.2 catch-up work is tracked in [`v0.2-catch-up-plan.md`](./v0.2-catch-up-plan.md). This doc covers `mast`'s web-based interactive surface — the operator-facing UI that replaces the embedded terminal TUI in the lean fork's scope.

## Why a web UI (not a terminal TUI)

The lean-fork design originally inherited core-agent's TUI story: embedded `bubbletea` + remote `core-agent-tui` over the attach protocol. On reflection, that shape fits core-agent (developer + cogo-shaped experimentation) better than it fits `mast` (unattended platform-agent runtime).

`mast` is fundamentally a backend agent process: it runs in a Cloud Run pod / Kubernetes service / daemon container, where all the load-bearing infrastructure (MCP servers, K8s context, credentials, audit log, cost ceilings, shared memory, watchdog) lives. The interactive surface is "operator drops in remotely to check progress, give a new task, verify a hypothesis" — a use case better served by a browser than a terminal:

- **No client installation.** Browse to URL vs. `go install core-agent-tui`. Critical for ops/SRE teams.
- **Aligns with deployment shape.** Cloud Run / K8s services are naturally interacted with via HTTP. The browser is the lowest-friction front-end.
- **Multi-operator-friendly.** Two SREs viewing the same incident-triage session at once is natural in a browser; awkward in a terminal.
- **Auth integration.** SSO/OIDC/IAP, the same auth path used for kubectl/console access.
- **Richer rendering primitives.** Syntax highlighting, collapsible tool-call sections, streaming token-by-token, file uploads, plan-first plan rendering, watchdog-alert visualization — all natural in HTML, fiddly in a terminal.
- **Mobile-viable.** A status check from a phone is at least possible.

The terminal-TUI use case (developer iterating on agent design locally) is genuinely better served by core-agent + `core-agent-tui`. Mast doesn't try to be both products.

## Architectural pattern: thin client over attach mode

Mast already publishes its agent state via `pkg/attach/` (HTTP/SSE, with auth via bearer token / mTLS / Cloud Run IAM / Google ID tokens). `mast-web` is a thin client over that same protocol — no new server-side machinery required on the agent side.

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

**What this is *not*:** the cogo-wasm2 pattern (agent loop in browser via WASM, thin auth proxy on backend). That pattern fits cogo's job — browser-based exploratory tool, per-user isolation, no persistent backend. It's structurally wrong for mast, where the *value* is the persistent backend agent with audit log, multi-operator sessions, and tool execution that requires backend context.

Cogo-wasm2 is a peer architecture for a different job, not a template to copy wholesale. But — see "What we reuse" — its rendering surface ports directly.

### Where `mast-web` runs is a separate question from *what* it is

The architectural pattern above (browser-as-thin-client over the attach protocol) is invariant. What changes between deployment shapes is **where the static assets live** and **whether something between the browser and the backend proxies the API calls**. See the "Deployment options" section below for the four supported shapes.

## What we reuse from cogo-wasm2

Concrete reusable assets (measured 2026-06-11 against `../cogo-wasm2`):

| Asset | LOC | Reuse plan |
|---|---|---|
| `web/index.html` (structure: sidebar + main + status bar + modals) | 128 | **Port verbatim** with cosmetic rename. Layout fits mast's needs. |
| `web/styles.css` (TUI-aesthetic, Go brand palette, monospace, dark theme) | 815 | **Port verbatim.** Re-skin to mast's branding (likely keep nautical/structural aesthetic to match the name). Layout, typography, dark mode, status bar — all directly applicable. |
| `web/app.js` rendering layer (~85% of file) | ~850 | **Port with surgical replacement.** Keep: message rendering (`addMessage`, `addTurnFooter`, `injectCitations`), tool-call rendering (`addToolCallMessage`, `addToolPendingMessage`, `completeToolMessage`, `addBuiltinToolMessage`), streaming (`createStreamingMessage`, `updateStreamingMessage`, `startThinking`), markdown + syntax highlight (`configureMarkdown`, `renderMarkdown`), sidebar machinery (`updateModelSelect`, `updateServerList`, `pollServerListUntilStable`), status bar (`updateStatusBar`), slash commands (~10 commands, all reusable shapes), batch run (`renderBatchTable`, `sortBatchTable`), citations injection. Replace: the ~150-LOC WASM coupling layer (`loadWasm`, `window.go.*` calls, ready-checks). |
| Markdown + syntax highlight bundle | (CDN) | **Port verbatim.** `marked@12` + `marked-highlight@2` + `highlight.js@11/github-dark`. Same CDN imports. |
| `wasm_exec.js` | 575 | **Drop.** Not needed — no WASM in mast-web. |
| First-run setup modal pattern | (in index.html) | **Port and adapt** — instead of GCP project/region, prompts for mast endpoint URL + auth token. |
| Slash-command surface (`/help`, `/model`, `/mcp`, `/stats`, `/batch`, `/export`, `/clear`, `/whoami`, `/wipe`) | (~250 LOC across `cmd*` functions) | **Port the shape, re-wire to attach protocol.** Some commands map directly (e.g. `/stats` → query attach `/context` endpoint); some need re-thinking (e.g. `/wipe` semantics differ when state is server-side). |

**What we add new:**

- **Attach-protocol client** (replaces WASM-coupling layer): ~300-500 LOC TypeScript or vanilla JS. WebSocket or SSE connection to `mast`'s attach endpoint, handles auth handshake, event-stream parsing, request shape construction. Replaces every `window.go.*` call in cogo-wasm2's app.js.
- **Multi-session view** (new capability not in cogo-wasm2): mast supports multiple concurrent sessions (per [`core-agent/docs/site/content/docs/reference/multi-session.md`](https://github.com/go-steer/core-agent/blob/main/docs/site/content/docs/reference/multi-session.md) — the canonical reference; `docs/multi-session-design.md` in that repo is historical intent). Sidebar gains a "Sessions" list; clicking a session switches the chat surface to that session's stream.
- **Plan-first plan rendering** (new): when the plan-first gate is active, the model's submitted plan should render as a distinct UI element (not just inline chat), so the operator can review/approve/reject. Not part of cogo-wasm2 (which doesn't have a plan-first gate).
- **Watchdog alert surface** (new): structured alerts from `pkg/watchdog/` (per planned issue #159) render as banners or sidebar notifications, not buried in the chat stream.
- **Cost-ceiling indicator** (new): per-turn and per-session cost tracking with visual warning as ceilings approach. Cogo-wasm2 has stats; mast-web needs ceiling-aware UI.

## Stack decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language | **Vanilla JS** for v0.1 (TypeScript optional later) | Cogo-wasm2 is vanilla JS and that worked. Adding a build pipeline (TS, bundler) on day one trades simplicity for future-proofing we don't yet need. Revisit at v0.5 if app.js exceeds ~3000 LOC. |
| Framework | **None** (vanilla DOM + small helpers) for v0.1 | Cogo-wasm2 demonstrated that ~1000 LOC of vanilla JS handles a non-trivial agent UI. A framework (React/Svelte/Vue) adds build complexity for marginal gain at this scope. Reconsider if state management becomes hairy (multi-session, branching, etc.). |
| Build pipeline | **None / minimal** for v0.1 | Static assets served directly. No bundler, no transpiler. The "build" is `cp -R web/. dist/` plus a mirror into `internal/webui/dist/` for the Go server's `go:embed`. |
| Connection transport | **SSE for events, fetch for requests** (v0.1); evaluate WebSocket later | Mast's `pkg/attach/` publishes SSE per protocol v1.4.0 (const `ProtocolVersion` in `pkg/attach/events.go`; spec doc at `core-tui/docs/sse-event-stream-protocol.md`). v1.3.0 was consumed 2026-07-17 by the digest-`savings` sidecar; v1.4.0 (core-agent#344 + core-tui#68, both merged 2026-07-20) added the `capabilities.features` / `slash_commands` / `agent` / `caller_id` manifest fields + `/whoami` endpoint + `_render` / `_schema` slash-response conventions. Reusing the existing channel is the lowest-effort path. WebSocket bidirectional may be worth it for the operator-input path, but SSE + POST works for v0.1. |
| Static-server impl (container option) | **Tiny Go binary** (`cmd/mast-web-server/`, stdlib-only, ~200 LOC) | nginx/Caddy adds ops complexity, config files, and a CVE treadmill for what's effectively `http.FileServer` + `httputil.ReverseProxy`. A purpose-built ~200 LOC Go binary lets us add mast-specific affordances (server-side token injection, same-origin proxying with `FlushInterval=-1` for SSE) without configuration. |
| Container base image | **`gcr.io/distroless/static:nonroot`** | ~10MB final image, no shell / no package manager / nonroot by default. Matches core-agent's image conventions. |
| Auth | **Reuse attach-mode auth paths** (bearer token, mTLS, Google ID token, IAP) | Already implemented in `pkg/attach/`. No new auth model in mast-web. Container's optional `BACKEND_TOKEN` injection lets operators run a "shared backend, single auth" setup where the SPA carries no auth at all. |
| Markdown / syntax highlight | **`marked@12` + `marked-highlight@2` + `highlight.js@11` via CDN** | Cogo-wasm2 uses these; they work. No reason to swap. |

## Repo placement

**Resolved 2026-06-12:** [`github.com/go-steer/mast-web`](https://github.com/go-steer/mast-web), separate repo.

Rationale:
- Different toolchain (web assets + a small Go binary in `cmd/mast-web-server/` vs core-agent's much larger Go module). Coupling them in one repo means CI changes for one affect the other.
- Different release cadence (web UI iteration faster than agent core).
- Different reviewer pool (frontend + backend skills overlap but aren't identical).
- Cogo-wasm2 is its own repo and that worked.

The repo holds three things:
1. The SPA source under `web/` (HTML/CSS/JS).
2. A small Go static-file server under `cmd/mast-web-server/` that bundles the SPA and optionally reverse-proxies attach calls. This is what powers the container deployment.
3. The Hugo documentation site under `docs/site/`.

## Deployment options

`mast-web` supports four deployment shapes that compose with the same SPA assets. Operators pick whichever fits their environment; the SPA itself is identical across all four.

| Option | What it is | Best for | Status |
|---|---|---|---|
| **Hosted SPA** | `mast-web` deployed once to GitHub Pages at `go-steer.github.io/mast-web/app/`; operators visit the URL and configure their backend on first run | "Just let me try mast" — zero setup | Planned (sibling docs.yml extension) |
| **Container image** | `ghcr.io/go-steer/mast-web:vX.Y.Z` — distroless image, ~10MB, embeds SPA + tiny Go static-file server + optional reverse-proxy to backend | Production K8s / Cloud Run / Docker Compose | Shipped (PR #4) |
| **Agent `--ui` flag** | Opt-in flag on `core-agent` / `mast`; the agent serves the SPA at `/ui/*` on its existing attach listener, using a pinned mast-web release embedded via `go:embed` at agent build time | Single-binary deploys, air-gapped, local-dev iteration | **Shipped** — see [`core-agent/docs/site/content/docs/reference/web-ui.md`](https://github.com/go-steer/core-agent/blob/main/docs/site/content/docs/reference/web-ui.md) for the operator flow (`--ui`, `--ui-dir`, `.mast-web-version` pin) |
| **Tarball + self-host** | Download `mast-web-vX.Y.Z.tar.gz` from the GitHub release; serve `dist/` with any static host (nginx, Caddy, S3, etc.) | Custom CDN, strict hosting requirements, branded rebrand | Shipped (PR #3) |

### Two architectural sub-shapes

Across the four options, the browser ↔ backend communication takes one of two forms:

**A. Same-origin (recommended for production):** the static assets and the attach API appear under the same origin. Either because:
- The container image is configured with `BACKEND_URL`, so it reverse-proxies `<API_PREFIX>/*` to the backend
- The agent's `--ui` flag serves the SPA from the same listener as its attach endpoint
- The operator's own reverse proxy (in front of self-hosted tarball) routes both

```
┌──────────┐   same-origin    ┌──────────────┐   HTTP/SSE   ┌──────────────┐
│  browser │ ◄───────────────►│  proxy /     │ ◄──────────► │  attach API  │
│          │   /attach/*      │  agent / CDN │              │  (backend)   │
└──────────┘                  └──────────────┘              └──────────────┘
```

Pro: **no CORS configuration on the backend at all.** The SPA fetches via relative paths; the browser sees one origin.

**B. Cross-origin (for hosted-SPA-direct or split deployments):** the SPA loads from one origin (GitHub Pages), the attach API lives on another (the backend's URL). Requires the backend to allow the SPA's origin via CORS headers.

```
┌──────────┐   cross-origin   ┌──────────────────┐
│  browser │ ◄───────────────►│  attach API      │
│  (hosted │   HTTPS + CORS   │  (mast / core-   │
│   SPA)   │                  │  agent backend)  │
└──────────┘                  └──────────────────┘
```

Pro: lowest deployment friction for the operator (just visit a URL).
Con: backend needs CORS allow-listing per origin; operators with strict CORS policies can't use this shape.

### How the same SPA serves both sub-shapes

The SPA's first-run modal prompts for backend endpoint + auth token. The endpoint can be:
- A same-origin relative path (e.g. `/attach` when behind the container's proxy or the agent's `--ui` route)
- A full URL pointing at a different origin (cross-origin direct connection)

`web/attach-client.js` doesn't care which — it sends the configured paths verbatim.

## Phasing

**Phases A+B+C can start before the mast fork lands.** The attach protocol they consume already exists in core-agent's `pkg/attach/` (HTTP/SSE typed events per protocol v1.4.0). mast-web doesn't care which binary serves the attach endpoint — same protocol, same client. Build mast-web against `core-agent --attach-listen :7777` today; when mast forks and ships, flip the endpoint pointer. Zero code change on the mast-web side.

This decouples mast-web's calendar from the fork-design's trigger condition (#158-#161 + shared-memory stack landing in core-agent). Frontend work proceeds in parallel with backend work; different files, zero merge conflicts.

| Phase | Scope | Status |
|---|---|---|
| **Phase A — port cogo-wasm2 rendering surface** | New `go-steer/mast-web` repo. Port index.html (rename, cosmetic), styles.css (rebrand to mast palette), app.js (keep rendering, stub WASM-coupling layer with placeholder). Serve statics from a local dev server pointed at a mock attach endpoint. | [PR #1](https://github.com/go-steer/mast-web/pull/1) open |
| **Phase B — attach-protocol client** | Replace stubs with real SSE connection + POST for input. Auth handshake. Event-stream parsing (mapping `pkg/attach/`'s typed SSE events to UI updates). Wire chat send / receive / tool-call render to a live core-agent backend; flip endpoint to mast at fork time. | [PR #2](https://github.com/go-steer/mast-web/pull/2) open, stacked on #1 |
| **Phase C — tarball release pipeline** | Tag-triggered `release.yml` that builds `dist/`, packages as `mast-web-vX.Y.Z.tar.gz` + sha256, attaches to a GitHub Release. Foundation for both the container image and any self-host deployment. | [PR #3](https://github.com/go-steer/mast-web/pull/3) open, stacked on #2 |
| **Phase C+ — container image** | `cmd/mast-web-server/` Go static-file server + Dockerfile (distroless/static, multi-arch) + `release.yml` image push to `ghcr.io/go-steer/mast-web`. Optional `BACKEND_URL` reverse-proxy eliminates CORS. | [PR #4](https://github.com/go-steer/mast-web/pull/4) open, stacked on #3 |
| **Phase C++ — hosted SPA deploy** | `docs.yml` (or sibling workflow) deploys built `dist/` to GitHub Pages at `go-steer.github.io/mast-web/app/`. Operators visit the URL, point at their backend on first run. | Planned (small follow-up after #4) |
| **Phase C★ — agent `--ui` flag** | Add `--ui` flag to core-agent (later mast). Same-listener `/ui/*` route serving mast-web assets embedded via `go:embed` (or override via `--ui-dir` for local-dev iteration). Pinned mast-web version via `.mast-web-version` file. | **Shipped** — reference at [`core-agent/docs/site/content/docs/reference/web-ui.md`](https://github.com/go-steer/core-agent/blob/main/docs/site/content/docs/reference/web-ui.md); implementation in `core-agent/cmd/core-agent/main.go` + `pkg/attach/handlers_ui.go` + `internal/webui/` + `.mast-web-version` + `dev/tools/fetch-mast-web` |
| **Phase D — mast-specific UI** | Multi-session sidebar. Plan-first plan rendering. Watchdog alert surface (consumes core-agent issue #159's in-band routing). Cost-ceiling indicators. Audit-log viewer (consumes audit-derived-memory work). | Feature-blocked on the post-fork roadmap |

Phase C, C+, C++, and C★ are all **independent deployment-shape work**; they all consume the SPA built in Phase A+B. Operators pick whichever fits their environment — see "Deployment options" above.

### Side effects of starting before the fork

- **Core-agent inherits the web UI during the transition.** mast-web speaks the attach protocol; the protocol exists in core-agent. So core-agent's audience (cogo-shaped experimentation) gets a richer interaction surface for free, at zero marginal cost. Not the primary motivation, but a real upside.
- **Validates the attach protocol from a non-TUI consumer.** `core-agent-tui` is the only attach consumer today. Building a second consumer surfaces protocol gaps (paste images, multi-session display, richer event types — open question 3 below) while we can still extend the protocol freely on a single repo. Cheaper than fixing them after the fork lands.
- **Branding hedge.** Repo created as `go-steer/mast-web` from day one; consumer doesn't care what backend binary it talks to. At fork time the backend pointer flips. The "mast-web predates mast" framing is mildly awkward externally but mechanically clean.

### Risks of starting before the fork

- **Phase D drift.** A+B+C ship a functional web UI in ~4 weeks, after which there's a wait for the post-fork features that justify the mast-specific UI elements. Mitigation: that's fine — A+B+C is itself a meaningful product (operator UI for any attach-enabled agent), and D can land incrementally as underlying features ship.
- **Reduces felt urgency of the fork.** If `mast-web + core-agent` works well, the impulse to actually do the fork may soften. Worth noting honestly. Mitigation: the fork's value is in the *cuts* (per [positioning.md](https://github.com/go-steer/mast/blob/main/docs/positioning.md)), not the *rename* — a working web UI doesn't change the underlying motivation. But the risk is real, and the team should commit to the fork on its own merits, not delay it because the web UI made core-agent feel adequate.

## Open questions

1. **TypeScript at the v0.1 cutover, or stay vanilla JS until pain forces the issue?** Bias: stay vanilla. Add TS only when type errors become an actual debugging cost.
2. ~~**`/wipe` / `/clear` semantics.**~~ **Resolved 2026-07-20:** `DELETE /sessions/{app}/{sid}` landed in core-agent for server-side session removal (guards the bootstrap `default` sid with 403). mast-web's `/clear` is view-only DOM clear; the sidebar's per-row × button drives the real delete. Wired in mast-web PR 2 (#15).
3. **Framework adoption trigger.** What size / complexity of app.js justifies React/Svelte? Cogo-wasm2 sits at ~1000 LOC vanilla and is fine. Mast-web with multi-session + plan-first + watchdog UI may reach ~2500-3000 LOC; that's the rough decision point.
4. **Slash command surface alignment.** Cogo-wasm2 has `/help /model /mcp /stats /batch /export /clear /whoami /wipe`. Mast's needs differ — see the v0.2 catch-up plan §"Capability-driven UI" for the resolution: server advertises `capabilities.slash_commands: [names]` (from [core-agent#329](https://github.com/go-steer/core-agent/issues/329)) and the client renders known names via a static metadata table with generic fallback for unknown ones. No hardcoded `if (backend === 'mast')` branch.
5. **Does `core-agent` get its own forked-from-cogo-wasm2 web UI for symmetry**, or does it stay terminal-TUI-first?** Probably the latter — core-agent's audience (cogo-shaped experimentation, dev iteration) values the terminal more. But: under the container-image deployment, the same mast-web container works against either backend, so "symmetry" is partly automatic.
6. **Default in `mast-web-server` for `BACKEND_TOKEN` shape.** Single shared token (simplest) vs OIDC/JWT exchange (production-grade)? Bias: single shared token for v0.1; document upgrade to OIDC for ops teams that need per-user identity. Real answer depends on multi-tenant timeline from the mast fork.
7. ~~**`.mast-web-version` pin format and bump cadence in core-agent.**~~ **Resolved 2026-07-20:** landed upstream as a plain top-level `.mast-web-version` file (`version=vX.Y.Z` shape). `dev/tools/fetch-mast-web` downloads the pinned release; bumping is a 1-line PR. See [`core-agent/docs/site/content/docs/reference/web-ui.md`](https://github.com/go-steer/core-agent/blob/main/docs/site/content/docs/reference/web-ui.md).

## Out of scope

- WASM-anything. Mast-web is plain HTML/CSS/JS. No Go-compiled-to-WASM agent loop; the agent lives on the backend.
- Cross-frame messaging / browser extension surface. If someone wants mast embedded in another product later, that's a separate design.
- Mobile-native apps. Mobile-via-browser-responsive is the v0.1 mobile story.
- Server-side rendering (SSR). The SPA is operator-facing and authenticated; SEO isn't relevant.
- Plugin / extension API in the SPA. Customization happens by forking the repo and serving your own build (the tarball or container path). Adding a plugin runtime would balloon mast-web's scope.

## Related

- [positioning.md](https://github.com/go-steer/mast/blob/main/docs/positioning.md) — the lean-fork thesis this serves
- [fork-design.md](https://github.com/go-steer/mast/blob/main/docs/fork-design.md) — references this doc for the web-UI piece
- [specialists-design.md](https://github.com/go-steer/mast/blob/main/docs/specialists-design.md) — the subagent-as-tool subsystem the UI surfaces alongside the chat stream
- [ag-ui-design.md](https://github.com/go-steer/mast/blob/main/docs/ag-ui-design.md) — mast's plans to be an AG-UI server (CopilotKit / messenger bots). Not consumed by mast-web today; noted so future contributors know attach isn't the only wire mast will speak
- [attach-mode-design.md](https://github.com/go-steer/core-agent/blob/main/docs/attach-mode-design.md) — the protocol mast-web consumes
- [SSE wire protocol spec](https://github.com/go-steer/core-tui/blob/main/docs/sse-event-stream-protocol.md) — the versioned wire contract (currently v1.4.0)
- [attach-tui-design.md](https://github.com/go-steer/core-agent/blob/main/docs/attach-tui-design.md) — the terminal-TUI design mast-web replaces (in the mast scope)
- [core-agent web-ui reference](https://github.com/go-steer/core-agent/blob/main/docs/site/content/docs/reference/web-ui.md) — the `--ui` flag operator flow (Phase C★ shipped)
- [mastersingh24/cogo-wasm2](https://github.com/mastersingh24/cogo-wasm2) — the project this borrows rendering surface from
