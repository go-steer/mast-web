# mast-web: design

**Status:** draft, 2026-06-11. Migrated from `core-agent/docs/mast/web-design.md` on 2026-06-12 as part of mast-web repo init. Companion to [fork-design.md](https://github.com/go-steer/core-agent/blob/main/docs/mast/fork-design.md) (which specifies `mast` as the lean-fork project) and [positioning.md](https://github.com/go-steer/core-agent/blob/main/docs/mast/positioning.md) (the thesis). This doc covers `mast`'s web-based interactive surface — the operator-facing UI that replaces the embedded terminal TUI in the lean fork's scope.

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

Mast already publishes its agent state via `pkg/attach/` (HTTP/SSE, with auth via bearer token / mTLS / Cloud Run IAM / Google ID tokens). `mast-web` is a thin client over that same protocol — no new server-side machinery required.

```
┌──────────────┐   WebSocket/SSE    ┌──────────────────────┐    HTTP/MCP    ┌──────────────────┐
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
- **Multi-session view** (new capability not in cogo-wasm2): mast supports multiple concurrent sessions (per `docs/multi-session-design.md` v2.4). Sidebar gains a "Sessions" list; clicking a session switches the chat surface to that session's stream.
- **Plan-first plan rendering** (new): when the plan-first gate is active, the model's submitted plan should render as a distinct UI element (not just inline chat), so the operator can review/approve/reject. Not part of cogo-wasm2 (which doesn't have a plan-first gate).
- **Watchdog alert surface** (new): structured alerts from `pkg/watchdog/` (per planned issue #159) render as banners or sidebar notifications, not buried in the chat stream.
- **Cost-ceiling indicator** (new): per-turn and per-session cost tracking with visual warning as ceilings approach. Cogo-wasm2 has stats; mast-web needs ceiling-aware UI.

## Stack decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language | **Vanilla JS** for v0.1 (TypeScript optional later) | Cogo-wasm2 is vanilla JS and that worked. Adding a build pipeline (TS, bundler) on day one trades simplicity for future-proofing we don't yet need. Revisit at v0.5 if app.js exceeds ~3000 LOC. |
| Framework | **None** (vanilla DOM + small helpers) for v0.1 | Cogo-wasm2 demonstrated that ~1000 LOC of vanilla JS handles a non-trivial agent UI. A framework (React/Svelte/Vue) adds build complexity for marginal gain at this scope. Reconsider if state management becomes hairy (multi-session, branching, etc.). |
| Build pipeline | **None / minimal** for v0.1 | Static assets served directly. No bundler, no transpiler, no Node toolchain. Cogo-wasm2's `make build-wasm` is the only build step; mast-web doesn't need even that. |
| Connection transport | **SSE for events, fetch for requests** (v0.1); evaluate WebSocket later | Mast's `pkg/attach/` already publishes SSE per protocol v1.1.0 (`975c89c`). Reusing the existing channel is the lowest-effort path. WebSocket bidirectional may be worth it for the operator-input path, but SSE + POST works for v0.1. |
| Asset hosting | **Static assets served by mast itself** (or sibling Cloud Run service for prod) | Mast's HTTP server can serve `/web/*` statics. For prod, a separate Cloud Run service hosting the static assets behind IAP is cleaner (CDN-cacheable, no impact on agent process). |
| Auth | **Reuse attach-mode auth paths** (bearer token, mTLS, Google ID token, IAP) | Already implemented in `pkg/attach/`. No new auth model in mast-web. |
| Markdown / syntax highlight | **`marked@12` + `marked-highlight@2` + `highlight.js@11` via CDN** | Cogo-wasm2 uses these; they work. No reason to swap. |

## Repo placement

**Recommendation: `github.com/go-steer/mast-web`** (separate repo).

Rationale:
- Different toolchain (web assets vs Go binary). Coupling them in one repo means CI changes for one affect the other.
- Different release cadence likely (web UI iteration faster than agent core).
- Different reviewer pool (frontend + backend skills overlap but aren't identical).
- Cogo-wasm2 is its own repo and that worked.

Alternative: `mast/web/` subdirectory. Simpler ops (one repo) but couples builds and release. Reject for now.

The mast Go binary serves `mast-web` static assets via embedded files (`go:embed`) at build time — so end users `go install mast` and get the web UI for free, without managing two artifacts. This is the same pattern Hugo and other Go projects use. The separate repo holds the *source*; the binary embeds the *built* assets.

## Phasing

**Phases A+B+C can start before the mast fork lands.** The attach protocol they consume already exists in core-agent's `pkg/attach/` (HTTP/SSE typed events per protocol v1.1.0, shipped in `975c89c`). mast-web doesn't care which binary serves the attach endpoint — same protocol, same client. Build mast-web against `core-agent --attach-listen :7777` today; when mast forks and ships, flip the endpoint pointer (and the `go:embed` target in phase C). Zero code change on the mast-web side.

This decouples mast-web's calendar from the fork-design's trigger condition (#158-#161 + shared-memory stack landing in core-agent). Frontend work proceeds in parallel with backend work; different files, zero merge conflicts.

| Phase | Scope | Effort | Gated by fork? |
|---|---|---|---|
| **Phase A — port cogo-wasm2 rendering surface** | New `go-steer/mast-web` repo. Port index.html (rename, cosmetic), styles.css (rebrand to mast palette), app.js (keep rendering, stub WASM-coupling layer with placeholder). Serve statics from a local dev server pointed at a mock attach endpoint. | ~1-2 weeks | **No.** |
| **Phase B — attach-protocol client** | Replace stubs with real SSE connection + POST for input. Auth handshake. Event-stream parsing (mapping `pkg/attach/`'s typed SSE events to UI updates). Wire chat send / receive / tool-call render to a live core-agent backend; flip endpoint to mast at fork time. | ~1-2 weeks | **No.** Surfaces protocol gaps now while they're cheap to fix on a single repo. |
| **Phase C — `go:embed` integration** | Wire the agent binary's HTTP server to serve `mast-web`'s built assets via `go:embed`. Operator runs the binary, browses to `:7777/ui`, gets the full web UI without separate deployment. Initially embedded into `core-agent` if landed pre-fork; flips to `mast` at fork time (mechanically identical). | ~2-3 days | **Partially.** The mechanism works pre-fork; the binary-name flip happens at fork time. |
| **Phase D — mast-specific UI** | Multi-session sidebar. Plan-first plan rendering. Watchdog alert surface (consumes issue #159's in-band routing). Cost-ceiling indicators. Audit-log viewer (consumes audit-derived-memory work). | ~2-3 weeks | **Yes — feature-blocked.** Depends on multi-session deployment (v2.4), plan-first gate UX, watchdog→model routing (#159), shared-memory implementation. These sit after the fork in phase 3. |
| **Phase E — production hosting story** | Docs + example for hosting mast-web behind IAP/Cloud Run for production deployments where the operator UI shouldn't be served by the agent process itself. | ~1 week | **No.** Can land alongside Phase C. |

Total estimate: ~6-9 weeks for a production-ready mast-web. Phases A+B+C+E (functional UI + production hosting) is ~4-5 weeks and unblocked today; Phase D adds the mast-specific polish as its underlying features ship.

### Side effects of starting before the fork

- **Core-agent inherits the web UI during the transition.** mast-web speaks the attach protocol; the protocol exists in core-agent. So core-agent's audience (cogo-shaped experimentation) gets a richer interaction surface for free, at zero marginal cost. Not the primary motivation, but a real upside.
- **Validates the attach protocol from a non-TUI consumer.** `core-agent-tui` is the only attach consumer today. Building a second consumer surfaces protocol gaps (paste images, multi-session display, richer event types — open question 3 below) while we can still extend the protocol freely on a single repo. Cheaper than fixing them after the fork lands.
- **Branding hedge.** Repo created as `go-steer/mast-web` from day one; consumer doesn't care what backend binary it talks to. At fork time the backend pointer flips. The "mast-web predates mast" framing is mildly awkward externally but mechanically clean.

### Risks of starting before the fork

- **Phase D drift.** A+B+C ship a functional web UI in ~4 weeks, after which there's a wait for the post-fork features that justify the mast-specific UI elements. Mitigation: that's fine — A+B+C is itself a meaningful product (operator UI for any attach-enabled agent), and D can land incrementally as underlying features ship.
- **Reduces felt urgency of the fork.** If `mast-web + core-agent` works well, the impulse to actually do the fork may soften. Worth noting honestly. Mitigation: the fork's value is in the *cuts* (per [positioning.md](https://github.com/go-steer/core-agent/blob/main/docs/mast/positioning.md)), not the *rename* — a working web UI doesn't change the underlying motivation. But the risk is real, and the team should commit to the fork on its own merits, not delay it because the web UI made core-agent feel adequate.

## Open questions

1. **TypeScript at the v0.1 cutover, or stay vanilla JS until pain forces the issue?** Bias: stay vanilla. Add TS only when type errors become an actual debugging cost.
2. **Framework adoption trigger.** What size / complexity of app.js justifies React/Svelte? Cogo-wasm2 sits at ~1000 LOC vanilla and is fine. Mast-web with multi-session + plan-first + watchdog UI may reach ~2500-3000 LOC; that's the rough decision point.
3. **Hosting model for production.** Does mast-web ship as embedded statics only (one binary, simple), or as a separately-deployed sibling Cloud Run service (cleaner separation, scales independently)? Bias: support both, default to embedded for ease, document the separate-service pattern for ops teams that want it.
4. **Does mast-web get its own auth model, or strictly inherit attach mode's?** Bias: strictly inherit. No new auth surface to maintain.
5. **Slash command surface alignment.** Cogo-wasm2 has `/help /model /mcp /stats /batch /export /clear /whoami /wipe`. Mast's needs differ — some commands map cleanly (`/help`, `/model`, `/mcp`, `/stats`), some need rethinking (`/wipe` server-side vs browser-side), some are mast-specific (`/sessions`, `/plan-status`, `/cost`, `/reset-ceiling`). Worth a dedicated audit before phase B.
6. **Does `core-agent` get its own forked-from-cogo-wasm2 web UI for symmetry**, or does it stay terminal-TUI-first? Probably the latter — core-agent's audience (cogo-shaped experimentation, dev iteration) values the terminal more. But worth confirming.

## Out of scope

- WASM-anything. Mast-web is plain HTML/CSS/JS. No Go-compiled-to-WASM agent loop; the agent lives on the backend.
- Cross-frame messaging / browser extension surface. If someone wants mast embedded in another product later, that's a separate design.
- Mobile-native apps. Mobile-via-browser-responsive is the v0.1 mobile story.
- Self-hostable static-asset CDN configuration. Operators host wherever they host static assets; mast-web doesn't prescribe.

## Related

- [positioning.md](https://github.com/go-steer/core-agent/blob/main/docs/mast/positioning.md) — the lean-fork thesis this serves
- [fork-design.md](https://github.com/go-steer/core-agent/blob/main/docs/mast/fork-design.md) — references this doc for the web-UI piece
- [specialists-design.md](https://github.com/go-steer/core-agent/blob/main/docs/mast/specialists-design.md) — the subagent-as-tool subsystem the UI surfaces alongside the chat stream
- [attach-mode-design.md](https://github.com/go-steer/core-agent/blob/main/docs/attach-mode-design.md) — the protocol mast-web consumes
- [attach-tui-design.md](https://github.com/go-steer/core-agent/blob/main/docs/attach-tui-design.md) — the terminal-TUI design mast-web replaces (in the mast scope)
- [mastersingh24/cogo-wasm2](https://github.com/mastersingh24/cogo-wasm2) — the project this borrows rendering surface from
