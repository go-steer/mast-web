# mast-web: bootstrap plan

**Status:** draft, 2026-06-12. Migrated from `core-agent/docs/mast/web-bootstrap.md` on 2026-06-12 as part of mast-web repo init. The repo-init portion of this plan has been executed (you are reading the result); phases A, B, C remain. Companion to [web-design.md](./web-design.md) (the architecture), which stays evergreen.

## Current state (as of 2026-06-12 repo init)

- `github.com/go-steer/mast-web` exists (private at init; flips to public when phase A merges per open question 7's bias).
- Repo scaffolded with LICENSE, README, CI workflows, Hugo docs site, dev/tools/ tooling, and these two design docs. See the initial commit.
- Backend for phases A+B is `core-agent --attach-listen :7777` (per [web-design.md](./web-design.md)). No mast binary required.

## What "matches the usual CI" means here

The convention across `core-agent`, `simian-agent`, `cogo`, `core-tui`, `gke-mcp` is:

- **GitHub Actions workflows under `.github/workflows/`**, with the canonical names: `ci.yml`, `ci-docs.yml`, `docs.yml`, `release.yml` (or `release-images.yml` for image-publishing repos).
- **Each CI job is a thin wrapper over a script under `dev/ci/presubmits/<name>`.** Same script runs locally and in CI ("green local = green remote").
- **Each presubmit delegates to `dev/tools/<name>`** for the actual logic. Logic lives in `dev/tools/`, not in YAML.
- **Apache 2.0 license header on every source file.** Standard 13-line preamble.
- **Hugo docs at `docs/site/`** with Docsy theme pulled via Hugo modules (no npm install at build time). Deployed via `docs.yml` to GitHub Pages.
- **Go 1.26, Hugo 0.158.0, Node 20** as the toolchain pins (when applicable).

mast-web inherits the *pattern* but adapts the *content*: it's a static web app, not a Go project. The presubmit set therefore differs — no `go build`, no `vet`, no `verify-mod-tidy`. The shape stays identical (thin delegators under `dev/ci/presubmits/`, real logic under `dev/tools/`).

## Proposed project layout

```
mast-web/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                  # lint + format + tests on push/PR
│   │   ├── ci-docs.yml             # docs build smoke (no deploy)
│   │   ├── docs.yml                # Hugo build + deploy to GitHub Pages on main
│   │   └── release.yml             # tag-triggered release of built static bundle
│   └── ISSUE_TEMPLATE/             # if we want; can defer
├── web/                            # the actual SPA (mirrors cogo-wasm2/web/)
│   ├── index.html
│   ├── styles.css
│   ├── app.js                      # vanilla JS, no build step v0.1
│   └── assets/                     # logos, fonts, etc.
├── dist/                           # build output (gitignored)
├── dev/
│   ├── ci/
│   │   └── presubmits/             # CI delegators (one bash script each)
│   │       ├── lint-js
│   │       ├── lint-css
│   │       ├── verify-format
│   │       ├── test-unit
│   │       ├── build
│   │       └── verify-html
│   └── tools/                      # actual logic the presubmits invoke
│       ├── lint-js
│       ├── lint-css
│       ├── verify-format
│       ├── test-unit
│       ├── build
│       ├── verify-html
│       ├── dev                     # local dev server (serves web/ on :8000)
│       └── ci                      # `dev/tools/ci` — runs all presubmits locally
├── docs/
│   └── site/                       # Hugo site (Docsy theme, mirrors core-agent's layout)
│       ├── hugo.yaml
│       ├── go.mod                  # for Hugo modules (Docsy, dependencies)
│       ├── go.sum
│       ├── package.json            # if Docsy requires it
│       ├── assets/
│       │   └── scss/               # Hugo SCSS overrides
│       └── content/
│           └── docs/
│               ├── _index.md
│               ├── getting-started.md
│               ├── architecture.md
│               ├── deployment.md
│               ├── reference/
│               │   ├── slash-commands.md
│               │   └── attach-protocol-mapping.md
│               └── customization.md
├── CHANGELOG.md
├── LICENSE                         # Apache 2.0 (copy verbatim from core-agent)
├── Makefile                        # convenience entrypoints (matches cogo-wasm2 style)
├── README.md
├── .gitignore
└── .editorconfig
```

**Notably absent:**

- No `go.mod` at the repo root. mast-web is pure web assets; the only Go is the Hugo site's modules under `docs/site/`.
- No `cmd/` directory. mast-web doesn't ship a Go binary; the dev server in `dev/tools/dev` is a small shell wrapper around `python3 -m http.server` (or similar — see open question 1).

## CI presubmits — what each does

Adapting the Go-project pattern (`build / lint-go / test-unit / verify-go-format / verify-mod-tidy / verify-vuln / vet`) for a static-web project:

| Presubmit | Purpose | Tool |
|---|---|---|
| `lint-js` | Lint JS for obvious errors | `eslint` with a minimal config (no React/TS rules; vanilla JS rules only) |
| `lint-css` | Lint CSS for unused selectors, syntax errors | `stylelint` with the recommended config |
| `verify-format` | Enforce formatting (replaces `verify-go-format`) | `prettier --check` over `web/**/*.{js,css,html}` |
| `test-unit` | Run JS unit tests | `vitest` if any tests exist; no-op pass if none yet (we will have some by phase B) |
| `build` | Minify/bundle (replaces `go build`) | For v0.1 vanilla JS: copies `web/` → `dist/` with optional minification. Becomes a real build step if we adopt TypeScript or a framework later. |
| `verify-html` | Sanity-check HTML | `htmlhint` with the default ruleset |

Each presubmit script under `dev/ci/presubmits/<name>` is a one-line delegator:

```bash
#!/usr/bin/env bash
# CI delegator: runs <description> via dev/tools/<name>.
set -euo pipefail
exec "$(dirname "$0")/../../tools/<name>" "$@"
```

Matches the core-agent pattern exactly. Logic lives in `dev/tools/`.

**Tool installation:** node 20 + `npm install -g eslint prettier stylelint htmlhint vitest` (or a `package.json` with dev deps and a single `npm install` step in CI). Probably cleanest as a top-level `package.json` since mast-web already has node tooling for Hugo's npm-driven assets, if any.

## Hugo docs scaffold

Mirror core-agent's setup exactly:

- `docs/site/hugo.yaml` — copy core-agent's, change `baseURL: "https://go-steer.github.io/mast-web/"` and `title: "mast-web"`. Same Docsy theme, same module pins.
- `docs/site/go.mod` + `go.sum` — Docsy + dependencies modules; copy from core-agent.
- `docs/site/assets/scss/` — Docsy customization overrides; copy core-agent's structure.
- `docs/site/content/docs/` — fresh content (see below).
- `docs/site/package.json` — if core-agent has one for asset processing; copy.

**Content to write first** (`docs/site/content/docs/`):

1. **`_index.md`** — landing page. *"mast-web is the operator-facing web UI for mast (and any attach-mode-compatible core-agent variant). Browser-based chat surface over the attach protocol; no agent loop in the browser."*
2. **`getting-started.md`** — "browse to URL, point at attach endpoint" walkthrough. Three flows: (1) local development against `core-agent --attach-listen`, (2) embedded into the agent binary via `go:embed`, (3) separately-hosted production deployment.
3. **`architecture.md`** — diagram + prose: browser ↔ attach protocol ↔ agent backend. Why not WASM-as-agent. Auth flow.
4. **`deployment.md`** — embedded vs separately-hosted. IAP / OIDC / mTLS configuration.
5. **`reference/slash-commands.md`** — `/help`, `/sessions`, `/model`, `/mcp`, `/stats`, `/clear`, etc. (consolidated when phase B settles the command surface).
6. **`reference/attach-protocol-mapping.md`** — which attach event types map to which UI behaviors. For people forking/customizing or building alternate consumers.
7. **`customization.md`** — re-skinning, slash-command additions, deployment patterns. Calls out the Go brand palette inheritance and the cogo-wasm2 lineage.

CI workflows for docs (`ci-docs.yml`, `docs.yml`) — copy from core-agent, change paths if needed.

## Phase A — port cogo-wasm2 rendering surface

**Inputs:**
- `~/projects/cogo-wasm2/web/index.html` (128 lines) — structural template
- `~/projects/cogo-wasm2/web/styles.css` (815 lines) — Go brand palette, monospace TUI aesthetic
- `~/projects/cogo-wasm2/web/app.js` (1005 lines) — keep ~85%, replace WASM coupling (~150 LOC) with stubs

**Output:**
- `mast-web/web/index.html` — port verbatim, cosmetic renames (`cogo` → `mast` in titles, ARIA labels, the sidebar logo). Strip the GCP-project-specific setup modal; replace with a "connect to attach endpoint" modal that prompts for URL + auth token.
- `mast-web/web/styles.css` — port verbatim. Cosmetic rebrand: keep the monospace TUI aesthetic and Go brand palette as the base (cogo lineage is fine to acknowledge), update the logo styling for mast's mark (TBD — simple text mark for v0.1).
- `mast-web/web/app.js` — port the rendering layer verbatim:
  - `addMessage`, `addSystemMessage`, `addTurnFooter`, `injectCitations`
  - `addBuiltinToolMessage`, `addToolPendingMessage`, `completeToolMessage`, `addToolCallMessage`
  - `createStreamingMessage`, `startThinking`, `updateStreamingMessage`
  - `configureMarkdown`, `renderMarkdown`, `escapeHtml`
  - `updateModelSelect`, `updateServerList`, `pushBuiltinTools`, `pollServerListUntilStable`
  - `updateStatusBar`, `startElapsedTimer`, `stopElapsedTimer`
  - All `cmd*` slash command handlers (port the shape; rewire bodies in phase B)
  - `renderBatchTable`, `sortBatchTable`, `downloadFile`
  - `loadPhrases`, `getStoredConfig`, `boot`
- Stub the WASM coupling layer (`loadWasm`, `initCogo`, every `window.go.*` call) with placeholder functions that log "TODO: phase B" and return mock data.
- Static dev server: `dev/tools/dev` runs `python3 -m http.server 8000` (or equivalent) from the `web/` directory.

**Acceptance for phase A:**
- `make dev` serves the UI on :8000.
- Opening `:8000` shows the full chat UI with sidebar, status bar, modals — visually complete, no backend connection.
- Slash commands print "TODO: phase B" messages.
- Mock conversation rendering: hardcode one user message + one streamed model response + one tool call to verify the rendering pipeline end-to-end with no backend.
- All CI presubmits green: `lint-js`, `lint-css`, `verify-format`, `verify-html`, `build` (where `build` is just `cp -r web/ dist/`).

**Effort:** ~1-2 weeks.

## Phase B — attach-protocol client

**What this replaces:** the WASM stubs from phase A.

**Inputs:**
- `core-agent`'s `pkg/attach/` source — defines the SSE event types and HTTP endpoints
- `docs/attach-mode-design.md` and `docs/attach-tui-design.md` from core-agent — the existing terminal consumer is a useful reference for "which events drive which behaviors"
- `core-agent --attach-listen :7777 --session-db` running locally as the backend

**Output:**
- `mast-web/web/attach-client.js` — new file, ~300-500 LOC. Implements:
  - SSE connection to `/events` endpoint
  - POST to `/inject` for user input
  - POST to `/wake` for resume
  - Auth handshake: bearer token (initially), with hooks for IAP/Google-ID-token added later
  - Event-stream parsing: maps typed SSE events (`assistant_text`, `tool_call`, `tool_result`, `turn_complete`, `cost_update`, etc.) to the UI rendering functions from phase A
  - Reconnection / retry with backoff
  - Connection-state indicator (the status bar gets a connection LED)
- `mast-web/web/app.js` — replace stub bodies with calls into `attach-client.js`. Slash commands wired to real backend endpoints.

**Acceptance for phase B:**
- Run `core-agent --attach-listen :7777 --session-db` in one terminal.
- Run `make dev` in another (serving mast-web on :8000).
- Browser at :8000 prompts for endpoint (`http://localhost:7777`) and token; connects; first-run modal closes.
- Type a prompt → streamed response renders in real time.
- Tool calls render with the cogo-wasm2 pending → completed visual flow.
- `/stats` shows real cost from the backend.
- `/clear` works (server-side state clearing semantics — see open question 2).
- Reconnection works after a backend restart.
- Unit tests added for event-stream parser and key UI state transitions.

**Effort:** ~1-2 weeks.

## Phase C — `go:embed` integration

**Where this lives:** primarily in `core-agent` initially (then in `mast` after the fork). NOT in the mast-web repo itself.

**What changes in mast-web:**
- Add a release pipeline (`.github/workflows/release.yml`) that on tag push builds the `dist/` bundle and attaches it to a GitHub release.
- Tag releases as `v0.1.0`, `v0.1.1`, etc.

**What changes in core-agent (then mast):**
- `cmd/core-agent/main.go` (and eventually `cmd/mast/main.go`) gains a static-asset handler that serves a `//go:embed all:web/*` bundle at `/ui/*`.
- Build process fetches the latest mast-web release tag and unpacks `dist/` into the embed path before the Go build runs.
- Operator runs `core-agent --attach-listen :7777` and browses to `http://localhost:7777/ui/` — same binary serves both the agent and the UI.

**Acceptance for phase C:**
- Tag mast-web v0.1.0; CI publishes a release with `dist.tar.gz`.
- core-agent's build pulls the release; `core-agent --attach-listen :7777` serves the UI at `/ui/`.
- Browser at `:7777/ui/` works end-to-end without a separate static server.

**Effort:** ~2-3 days for mast-web side; ~2-3 days for the core-agent integration. Done in parallel.

## Doc migration at repo init

The four mast docs currently live in core-agent's `docs/mast/`. When mast-web (and later mast) initialize, the docs split along ownership lines:

| Doc | Lives at repo init | Eventual home |
|---|---|---|
| [web-design.md](./web-design.md) | `~/projects/core-agent/docs/mast/web-design.md` (here, today) | `~/projects/mast-web/docs/web-design.md` |
| this doc (this doc) | here | `~/projects/mast-web/docs/web-bootstrap.md` (then deleted after execution) |
| [positioning.md](https://github.com/go-steer/core-agent/blob/main/docs/mast/positioning.md) | here | `~/projects/mast/docs/positioning.md` (after the fork) |
| [fork-design.md](https://github.com/go-steer/core-agent/blob/main/docs/mast/fork-design.md) | here | `~/projects/mast/docs/fork-design.md` (after the fork) |
| `./specialists-design.md` | here | `~/projects/mast/docs/specialists-design.md` (after the fork) |
| `./README.md` | here | needs splitting: a `mast/docs/README.md` index for mast-side docs, and a `mast-web/docs/README.md` pointing at `mast-web/docs/web-design.md` + cross-referencing the mast repo |

**Execution at mast-web repo init (as part of step 4 in the initial commit plan below):**

1. Copy `~/projects/core-agent/docs/mast/web-design.md` → `~/projects/mast-web/docs/web-design.md`.
2. Copy `~/projects/core-agent/docs/mast/web-bootstrap.md` → `~/projects/mast-web/docs/web-bootstrap.md`.
3. Update cross-references inside the copies:
   - [positioning.md](https://github.com/go-steer/core-agent/blob/main/docs/mast/positioning.md) → `https://github.com/go-steer/core-agent/blob/main/docs/mast/positioning.md` (until mast lands, then update to mast's docs)
   - [fork-design.md](https://github.com/go-steer/core-agent/blob/main/docs/mast/fork-design.md) → same pattern
   - `./specialists-design.md` → same pattern
   - `../attach-mode-design.md` → `https://github.com/go-steer/core-agent/blob/main/docs/attach-mode-design.md`
   - `../attach-tui-design.md` → same pattern
   - `../../cogo-wasm2/` → `https://github.com/<owner>/cogo-wasm2` (or local relative path if both repos are sibling clones — `../../cogo-wasm2/` works locally on most clones)
4. Add `~/projects/mast-web/docs/README.md` — short index pointing at the two docs and back to core-agent's `docs/mast/` for the broader mast design corpus.
5. **Delete the originals from `core-agent/docs/mast/`** in a follow-up commit on core-agent's side, replacing them with stubs that redirect: *"This doc has moved to https://github.com/go-steer/mast-web/blob/main/docs/web-design.md."* This avoids the docs drifting in two places.
6. Update `core-agent/docs/mast/README.md` and `core-agent/docs/mast/fork-design.md` to reflect the moved location.

**When the mast fork lands**, the same migration happens for positioning.md / fork-design.md / specialists-design.md → into mast's repo. Cross-references in mast-web's copies get updated to point at the new mast URLs.

## Initial commit plan

Recommended commit sequence on the new `mast-web` repo's `main` branch:

1. `chore: initialize repository (LICENSE, README, .gitignore, .editorconfig)`
2. `chore(ci): add presubmit scripts under dev/ci/presubmits/ and dev/tools/`
3. `chore(ci): add GitHub Actions workflows (ci, ci-docs)`
4. `docs: migrate web-design.md and web-bootstrap.md from core-agent (see "Doc migration at repo init" above for the URL-rewrite procedure)`
5. `chore(docs): scaffold Hugo site under docs/site/ (matches core-agent layout)`
6. `chore(docs): add GitHub Actions workflow for Hugo build + deploy`
7. `feat(web): port index.html and styles.css from cogo-wasm2 (phase A part 1)`
8. `feat(web): port app.js rendering surface; stub WASM coupling (phase A part 2)`
9. `feat(web): add local dev server (dev/tools/dev)`
10. `docs(getting-started): walkthrough for connecting to core-agent --attach-listen`

**Follow-up commit on core-agent** (separate PR, lands after the mast-web repo is public):
- `docs(mast): redirect web-design.md and web-bootstrap.md to mast-web repo`

That gets us through phase A on clean history in both repos. Phase B + phase C add subsequent commits.

## Open questions to resolve before starting

1. **Local dev server: `python3 -m http.server` or a small Go binary?** cogo-wasm2 uses Python. Pro of Python: zero dependencies on Go for the mast-web repo. Pro of Go: matches the rest of the go-steer toolchain. Bias: **Python** for v0.1 (don't introduce Go just for a dev server when the repo otherwise has no Go).
2. **`/clear` semantics in phase B** when state is server-side. Does `/clear` clear the *server's* session, or just the *browser's* view of it? Probably both (with confirmation), but worth thinking through.
3. **Auth bootstrap UX.** First-run modal asks for endpoint + bearer token. Where does the token come from? Operator copies it from `core-agent --attach-token-env=…` startup output? Or we add a `core-agent attach-print-token` subcommand for the dev case? Worth a small UX spike before phase B.
4. **mast-web's logo / mark.** Cogo-wasm2 has the stylized `c[o]go` mark with blinking cursor. mast wants a sibling treatment — `mast` with some nautical glyph? Or just plain text? Defer to a tiny design pass after phase A's visual port is up so we have something concrete to iterate on.
5. **GitHub Pages baseURL.** `https://go-steer.github.io/mast-web/` is the natural URL pattern. Confirm the org has Pages enabled and the workflow's `pages: write` permission will work without org-admin friction.
6. **Hugo theme.** Core-agent uses Docsy. Should mast-web also use Docsy for consistency, or pick something lighter (the docs site is small)? Bias: **Docsy** — consistency with the rest of go-steer is worth more than the marginal weight saving on a small site.
7. **Repo visibility.** Public from day one or private until phase A lands and we've validated the cogo-wasm2 port works? Bias: **private** until phase A is green, then flip to public alongside the README → "mast-web v0.1.0" announcement.

## What this plan does *not* cover

- The mast fork itself (covered by [fork-design.md](https://github.com/go-steer/core-agent/blob/main/docs/mast/fork-design.md)).
- Phase D and Phase E from [web-design.md](./web-design.md) (mast-specific UI elements + production hosting docs). Those happen after the fork lands.
- The Go-side `//go:embed` wiring in mast (Phase C's other half) — that's a mast PR, not a mast-web PR.
- Migration of issues / project boards from anywhere.
