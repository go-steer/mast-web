# Changelog

All notable, user-visible changes to mast-web. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## What a release is

Two artifacts, published together by `.github/workflows/release.yml` on a
`v*.*.*` tag:

- **`mast-web-<tag>.tar.gz`** — the built `dist/`, with a companion `.sha256`.
  This is the canonical thing downstream agent binaries (`core-agent`, `mast`)
  fetch and embed via `go:embed`.
- **`ghcr.io/go-steer/mast-web:<tag>`** — the multi-arch distroless image of
  `mast-web-server`, which is both the standalone mock and the hosted
  backend-for-frontend.

Those two have different audiences, and a change can break one without
touching the other. **Entries that affect embedders are marked
*[embedders]*; entries that affect a hosted deployment are marked
*[hosting]*.**

Pre-1.0, a breaking change may land at any minor version. When one does it is
recorded below under **Changed** or **Removed**, never only in a commit
message.

## [Unreleased]

Nothing yet.

## [0.5.0] - 2026-09-17

**Catching up to the wire, and the release where a parked session stopped
being a dead end.**

mast-web had been claiming attach protocol 1.7.0 since v0.3 while core-agent
moved to 1.12.0, and five minor versions of drift is not a version-number
problem: two of them changed behaviour the browser already depended on, and
both changes are invisible to a client that never asks. The sharp one is
**1.11.0, which removed the shim where an inject from a human-looking caller
released a hold** — on the grounds that callers carry an identity, not a
species. Correct upstream, and it turned a held session into a dead end here.
A session parked by another tab, an embedded `core-tui`, a scheduler or a cost
ceiling could be typed into forever: the message queues behind the gate and
nothing happens. The gate had been modelled in the store since v0.4 and there
was no control anywhere in either shell that could open one.

The rest of the release is the multi-user surface catching up with its own
premise. v0.4 made session ownership *visible*, and read-only — the v0.4 plan
recorded "core-agent ACL mutation — no route today" as the reason. 1.10.0
shipped the route, so v0.5 can grant and revoke from the browser that already
draws who owns what. And 1.12.0 made `state: "running"` reachable for the
first time, which is why this is also the release where "is anything running?"
became a question about the daemon rather than about this browser tab.

The reconciled architecture doc is [`web-design.md`](docs/web-design.md); the
release's plan, with the protocol drift enumerated item by item, is the
[v0.5 plan](docs/v0.5-plan.md).

### Added

- **The operator hold, in the browser.** A banner between the transcript and
  the prompt states the reason verbatim, whether the turn the hold interrupted
  was cancelled or is still unwinding, when it was set, and the ways out.
  `/pause [reason]`, `/continue` (alias `/cont`) and `/abandon` — `core-tui`'s
  vocabulary, deliberately, not the route's name `/resume`, which is the wrong
  word to say to a person. Typing at a held session **steers**: the text is
  sent as a correction rather than starting a turn that would block on the
  gate forever. A held count sits in the window's status bar, because the one
  place you cannot see a parked session from is anywhere but its own tab.
  (#70)
- **Session sharing — `/share`**, in the palette. `/share` lists the ACL,
  `/share viewer <identity>` and `/share contributor <identity>` grant, and
  `/share revoke <identity>` takes it back. Viewers and contributors stay distinct, and grants are
  exclusive: promoting a viewer removes them from viewers, because an identity
  in both lists would display two things about one permission. The `PATCH`
  sends only the list that actually changed, so an untouched list is never
  round-tripped from a snapshot that may already be stale — the lost-update
  window on an authorization decision is narrow enough as it is. What gets
  rendered is the server's echo, never the request. It is a command rather
  than a sidebar dialog for a load-bearing reason: the ACL routes are
  session-scoped and refuse with 404 rather than 403, so a sidebar row — which
  has never seen a protocol version, that header being stamped only on
  `/events` — could not tell "your backend is too old" from "this session is
  not yours". A panel knows both. (#91)
- **Rename a session from the sidebar.** A `✎` on rows the registry derived as
  mine. Clearing the name is a distinct instruction from leaving it alone, and
  re-arms the host's inference; the row shows the normalized title the server
  says it *stored*, not what was typed. `persisted: false` is not an error —
  it is the norm for a daemon with no ACL store, and reading it as failure
  would put an error on every successful rename. (#92)
- **`/perms`** — the permission mode, the standing allow/deny patterns, and
  the approval log. The log is the point: an allow-session granted an hour ago
  is invisible in every other surface. Since 1.10.0 a row can name who granted
  it. (#94)
- **Approval attribution on the permission card.** Answering a prompt now
  records the approver the daemon verified, beside the decision. The SPA never
  *sends* an approver — the server checks that field against its own verified
  caller, so anything the browser put there could only disagree — and it never
  fills a blank in with the reader's own identity. They are the likeliest
  author of any row and the most damaging to guess, because the log is
  consulted precisely when something got through that should not have. (#94)
- **Tool grants on `/specialists`**: per-source counts on the roster row, the
  full grouped grant on `/specialists <name>`. (#94)
- **`/subagents stop <name>`.** (#94)

### Changed

- **mast-web speaks attach protocol 1.12.0** (was 1.7.0). *[embedders]* Every
  new surface above is gated, so an older daemon loses controls rather than
  breaking — but the client now asks **three** capability questions instead of
  two, and the third defaults the other way. `emitsEvent` is about frames and
  `hasFeature` is about flags, where silence means a producer that predates
  the flag and *has* the feature; neither can answer "does this endpoint
  exist?", and the ACL and title routes carry no flag at all. So
  `protocolAtLeast()` joins them, and silence there means **off**: a server too
  old to have said is a server that will 404, and offering a Share control
  that 404s is worse than not offering one. (#90)
- **"N running" now counts sessions, not tabs.** Through 1.11.0 the browser
  could only answer "did I press send" — `state: "running"` was declared from
  the start and never produced, and `turn_in_flight` did not exist. A session
  another operator, an embedded TUI or a scheduler was driving looked idle in
  every surface this SPA draws: the fleet count, the panel footer, the busy
  pulse, the radar blip. A standing `GET /status` poll (ten seconds idle,
  three while held or in flight, stopped while the tab is hidden) makes the
  count honest. The two facts stay two facts, because `state` has one slot and
  pause outranks running in it: a session parked mid-turn reports "paused"
  while the turn the park interrupted is still executing, and a `⟳ turn in
  flight` slot in the footer is the only way that gets said. SEND and STOP
  keep their narrow local meaning — they are not things to do to an operator
  because somebody else is working. (#93)
- The tarball's mock backend (`mast-web-server --mode=mock`) advertises and
  implements 1.12.0, including a permission surface that can be prompted from
  outside (`POST /_mock/perms-prompt`) — it has no permission checker of its
  own, having no tools. (#90, #94)

### Fixed

- **`/pause`, `/continue` and `/abandon` were offered to backends that have no
  `/pause` route.** They were gated on the `pause` feature flag alone, and an
  absent flag reads as *on*, so a pre-1.5.0 daemon got all three. Caught by
  #91's version gate going past. Both gates now apply and they catch different
  backends: the flag catches one built without a `PauseController`, the
  version catches one built before the route existed. (#70, #91)
- The hold banner was drawn at **every** session: `.term-hold` sets
  `display:flex`, which beats the `[hidden]` attribute's UA rule. jsdom cannot
  see this, which is what the browser smoke suite is for. (#70)
- A `status-update` left at `streaming` was never retracted by
  `turn-complete` — not every producer retracts it — so a panel that believed
  the last frame it was given claimed to be working for the rest of the
  session. (#93)
- `client.js` documented `PauseResponse`'s keys as the short names the `pause`
  frame uses for the same two facts; they are `paused_since` and
  `pause_reason`. (#70)

### Known gaps

- **Nothing in CI has ever looked at the screen.** Every claim in this release
  is asserted by a test that runs headless. A manual walkthrough doc is
  written and in review; its acceptance criterion is a person running it once,
  which no presubmit can discharge.
  ([#99](https://github.com/go-steer/mast-web/issues/99))
- **The hold banner does not say how many subagents are still running** — the
  difference between "safe to walk away" and "wait". The subagent roster
  carries no status, and the one place a running count crosses the wire is an
  interrupt response, which a hold is not.
  ([#106](https://github.com/go-steer/mast-web/issues/106))
- Unchanged from v0.4 and all deliberately v0.6 or later:
  **`--auth-mode=oidc`** ([#86](https://github.com/go-steer/mast-web/issues/86)),
  the **Kind job running the mock rather than a real `core-agent`**
  ([#66](https://github.com/go-steer/mast-web/issues/66)), the **hosted SPA**
  ([#6](https://github.com/go-steer/mast-web/issues/6)), and **inline slash
  autocomplete** ([#43](https://github.com/go-steer/mast-web/issues/43)).

### Upgrading

- *[embedders]* Nothing to change. `core-agent` and `mast` can bump the
  embedded version; against a daemon older than the route a control is hidden
  rather than broken. What you get by *also* being on a current daemon:
  ≥1.10.0 for `/share` and rename, ≥1.12.0 for running counts that include
  turns this browser did not start.
- *[hosting]* No new flags. Sharing grants to whatever identity string you
  type, and the agent enforces it against the caller it verified — so under
  `--auth-mode=none` every browser reaches the agent as the same caller and a
  grant is recorded without changing what anyone can see. Sharing is only
  meaningful in a deployment that authenticates at the edge (`proxy-header` or
  `iap-jwt`) and forwards the human as `X-Asserted-Caller`.

## [0.4.0] - 2026-09-15

**Consolidation, and the release where mast-web became something you can host
for more than one person.**

Two distinct bodies of work landed in this window. The first, through August,
turned the SPA into a real multi-user surface: a backend-for-frontend that
authenticates the human at its own edge, and two new shells. The second —
the [v0.4 plan](docs/v0.4-plan.md), eight roadmap PRs — was explicitly a
*consolidation* release: it retired the classic console, collapsed three
presentations to two, unified the state seam both of them grew around, and
made the container image deployable. Read together: the features arrived
first, and then the codebase was made to survive them.

The headline number is that `web/app.js` — 4,305 lines by the time it went —
is gone, and nothing it did was lost.

### Added

- **Hosted multi-user mode** *[hosting]*. `mast-web-server` gained a
  backend-for-frontend shape: it authenticates the human at its own HTTP edge
  and forwards that identity to the agent as `X-Asserted-Caller`, so **the
  browser never holds an agent credential** and the agent's per-caller ACLs
  apply to the person rather than to the service account. Two authenticating
  edge modes ship — `proxy-header` (an identity header from a trusted fronting
  proxy) and `iap-jwt` (a validated Google IAP assertion) — alongside the
  default `none`. `--allow-unauthenticated` is not a third mode but a required
  acknowledgement: running an open proxy on a non-loopback address is now
  something you have to say out loud. New flags: `--auth-mode`,
  `--auth-header`, `--iap-audience`, `--allow-unauthenticated`,
  `--backend-auth`, `--backend-audience`, `--external-url`,
  `--sse-max-lifetime`. (#48)
- **The SPA discovers its own attach API.** A hosted deployment serving the
  API under `--api-prefix` used to require a human to type `/attach` into a
  form. The server always knew the answer; now the SPA asks for it. (#55)
- **`spatial.html`** — a 3D room with one live terminal per session, camera,
  grid planes and a radar. (#49)
- **`solo.html`** — the same terminal at full size with no room: one panel
  filling the stage and a tab strip. Every open session stays mounted and
  connected, so a turn started in one tab keeps streaming while you read
  another. `alt+1`…`9` selects, `alt+[` / `alt+]` steps, `alt+w` closes, and
  the layout is restored on reload. (#53)
- **Session ownership, visible.** Session rows are marked mine vs shared,
  derived per-daemon from `whoami` — each backend runs its own auth mode, so
  two attached daemons can legitimately answer differently. A shared session
  offers no delete control. (#63)
- **Nine command surfaces ported into the surviving shells**, which was the
  bill for retiring the classic console: `/tools` (grouped by source),
  `/subagents` (with `events <name> [since]` drill-down), `/usage` (session
  totals plus the per-model split), `/whoami`, `/guardrails [reset]`, and
  session delete as a sidebar gesture. (#59, #60)
- **One capability table for every command.** `/help` is filtered by the same
  `available()` call that dispatch checks, so a command the backend does not
  support does not appear rather than failing when you run it. Window-level
  commands (`/attach`, `/theme`, `/layout`, `/batch`, `/shell`, `/shortcuts`)
  live in `web/shell.js` and join the same table, so a shell cannot shadow a
  built-in. (#45, #60)
- **A real status bar**, shared by both shells, reporting window-level facts
  only: agents up/down, terminals open and running, summed cost, and who is in
  front. Deliberately not the per-panel conn/model/turns/cost a panel already
  shows in its own footer. (#62)
- **Eleven themes**, up from six: Go brand, Google grayscale (dark/light),
  Google Cloud light, Google Pantheon (dark/light), Solarized (dark/light),
  high contrast, monochrome, paper.
- **Room audio for the spatial shell** — five synthesized cues, no sample
  files and no CDN. Each cue is a shape rather than a note, so a rising
  interval reads as arriving without anyone being told which is which. **Off
  by default and persisted**, because sound on a web page is an imposition
  until it has been asked for.
- **Attach protocol 1.4.0 → 1.7.0.** The pause gate (1.5.0 §2.8) is now held
  as state rather than inferred, because "paused" and "no turn running" are
  different facts and anyone — another tab, an embedded TUI, a scheduler, a
  cost ceiling — can cause the transition. Two sources report it and disagree
  for about a second at a time; an applied push beats a contradicting poll for
  a two-second window, then the server wins again. Also `wake` (1.7.0 §2.9),
  session titles, and two-way gating. **See *Known gaps* — the operator-facing
  hold UX is deliberately not in this release.** (#69)
- **Kubernetes manifests and a CI job that deploys them.** `deploy/k8s/` as a
  kustomize base plus a kind overlay, and `dev/tools/kind-cluster`, which is
  where the logic lives — `.github/workflows/kind.yml` is a thin wrapper, so a
  red CI run reproduces with one command on a laptop. The overlay seam is a
  Service name (`BACKEND_URL` → `mast-web-backend`), so a GKE overlay should
  be an image pin and an `AUTH_MODE` patch rather than a rewrite of the base.
  (#64)
- **`purser.Caller`** as the server's internal identity type, the shared
  contract the rest of go-steer is converging on. No behaviour change; it
  makes the eventual OIDC swap a wiring change rather than a type migration.
  (#65)
- **Smoke coverage grew from 5 specs to 19**, including `019-multi-user`,
  which asserts in a browser what the real-backend rig asserts over curl. The
  mock serves two identities, selected by a `mock_caller` cookie.
- Grounding evidence renders as chrome — a search row and a numbered sources
  strip — instead of nine opaque redirect URLs inside the assistant's bubble.

### Changed

- **`web/index.html` is now a 47-line shell chooser, not the application.**
  *[embedders]* Anyone serving the tarball at `/` gets a chooser rather than a
  console. It keeps its *name* on purpose: a static host has no Go server to
  rewrite `/` with, and `http.FileServer` on a directory without an
  `index.html` gives a listing or a 403. Shell precedence is `?shell=` →
  `localStorage['mast-web:shell']` → `solo`; a `?shell=` deep link
  deliberately does not persist. (#61)
- **`/config` is now behind authentication** *[hosting]*. It was previously
  exempt on the theory that an unauthenticated SPA must be able to discover
  that it is unauthenticated — which does not survive contact with how the SPA
  loads, since the document request is what gets 401'd, so an unauthenticated
  SPA is never running to ask. The exemption bought nothing and cost the
  deployment's map, API prefix included, which points at the path where the
  BFF stamps `BACKEND_TOKEN`. `/healthz` and `/readyz` are now the entire
  anonymous surface. (#55)
- **The state stores are factories.** `MastState.session` and
  `MastState.connection` no longer export singletons; `createSession()` and
  `createConnection()` are the whole surface, and every terminal holds its own
  pair. Tests assert the singletons stay gone. (#58, #61)
- **Stop cancels the turn again, instead of parking the agent.** A regression
  in the pause work; the fix is what makes this release correct without the
  hold UX. (#73)
- Per-turn cost is claimed from `usage-update.last_turn` rather than
  `turn-complete.cost_usd`, which does not carry it. The priced number arrives
  *before* the turn completes, so the old back-filled footer printed every
  cost one turn late and left the newest turn blank.
- `#spatial-hud` / `-sidebar` / `-status` are `#app-*`; `spatial.css` split
  into `chrome.css`, `panel.css` and a room-only `spatial.css`, with no
  selector defined in two sheets. **Colour rule going forward: `--accent`
  means "this one is live"** — selected, in front, mid-turn, under the
  pointer. A control at rest is `--text`. (#62)
- The Go directive moved to `1.26.6`, required by purser. (#65)

### Removed

- **`web/app.js`** (4,305 lines) and the classic console it drew. (#61)
- **`/stats`** — the same numbers as `/usage` from a worse source, and broken
  since the `byModel` alignment. **`/endpoint`** — these shells hold several
  backends at once, so one endpoint field is the wrong model.
  **`/replan`**. None were ported, each on purpose.
- The SSE token no longer rides in the URL, where it authenticated nothing and
  leaked into proxy logs. (#48)
- Three third-party browser bundles are vendored under `web/vendor/` instead
  of loaded from a CDN. (#48)
- `injectCitations()` and the `onGrounding` / `onSearchQueries` / `onURLFetch`
  callbacks — inline claim-anchored pills need spans that never cross the
  attach wire, so none of it could ever fire.

### Fixed

- Syntax highlighting never loaded at all: the CDN path was a CommonJS module
  that threw on load. (#48)
- `deleteSession` 415'd against every real backend. (#48)
- `--api-prefix=/` panicked at boot on a duplicate mux pattern. (#48)
- The sessions-list wire shape did not match what real backends send. (#41)
- The turn footer rendered above the reply, and attaching mid-session showed
  an empty transcript over a live conversation. (#51, #54)
- **The shipped image could not run `--mode=mock` at all** — the mode reads
  frames from disk and the distroless runtime layer carried none, so
  `docker run … --mode=mock` could only ever fail. The image now carries the
  conformance fixtures (~96KB next to a ~10MB binary). (#64)
- A flake in `smoke/014-replayed-history`: the test's click had to scroll the
  control into view, and scrolling to the top *is* the auto-load gesture, so
  the test raced the feature it was testing. (#85)

### Security

*[hosting]* — all of this applies to a hosted deployment, not to an embedded
tarball.

- A Content-Security-Policy is served with the shells, and proxied request
  lifetime is capped.
- **`proxy-header` duplicate-header impersonation.** `Header.Get` returns the
  first value, so a fronting proxy that *appends* rather than replaces let an
  attacker name any identity. Ambiguous identity headers are now refused
  outright.
- The browser holds no agent credential in any hosted mode (#48), and
  `/config` no longer discloses the deployment's map to anonymous callers
  (#55).

### Known gaps

Deliberately not in this release, each tracked:

- **The operator-facing hold UX** — banner, park, steer, `/continue`,
  `/abandon`. The pause gate is modelled in the store but has no UI. v0.4
  removes surface area and this adds a banner, three commands and a second
  input mode.
  ([#70](https://github.com/go-steer/mast-web/issues/70))
- **`--auth-mode=oidc`** stays a hard error rather than a half-implementation.
  It was long recorded as *blocked* on purser shipping `authn/oidc`; purser
  phase 1a is complete and tagged `v0.1.0`, so as of this release it is a
  scope choice, not a dependency.
  ([#86](https://github.com/go-steer/mast-web/issues/86))
- **The Kind job runs the mock, not a real `core-agent`.** An unqualified
  green Kind run reads as more than it is, and the workflow says so in its own
  comments. ([#66](https://github.com/go-steer/mast-web/issues/66))
- Inline slash autocomplete
  ([#43](https://github.com/go-steer/mast-web/issues/43)) and the hosted SPA
  on GitHub Pages ([#6](https://github.com/go-steer/mast-web/issues/6)).

### Upgrading

- *[embedders]* `core-agent` and `mast` can bump their embedded version. The
  one thing to check is that **`index.html` is a chooser now** — if your
  integration deep-links users into the console, point it at `solo.html` (or
  `index.html?shell=solo`) rather than `/`.
- *[hosting]* If you run `mast-web-server` behind a proxy, `/config` now
  requires authentication; only `/healthz` and `/readyz` are anonymous. If
  your proxy *appends* to an existing identity header rather than replacing
  it, requests will now be refused instead of silently trusting the first
  value — strip client-supplied copies at the edge.

## [0.3.0] - 2026-07-21

Multi-daemon fan-out, the observer footer, and the renderer registry — closing
the debt v0.2.0 deferred.

### Added

- **Multi-daemon peer fan-out.** Live SSE connections to every added daemon in
  parallel, so a cross-daemon session switch is instant. The sidebar
  aggregates sessions across daemons with per-daemon badges, persisted in
  `localStorage`. (#38)
- **Observer-mode footer stamping.** Externally-driven turns render fully —
  assistant text, tool chips, per-turn footer — without a matching
  `runPrompt`. (#37)
- **Renderer registry.** Server-advertised slash commands return
  `_render`-tagged payloads dispatched to built-in renderers: `text`,
  `markdown`, `json`, sortable `table`, `<details>`-based `tree`. An optional
  `_schema` (JSON-Schema Draft-07 subset) validates before render. (#35)
- **Batch runner against a real backend** — sequential inject-per-prompt with
  streaming row updates, a stop button, real TTFB and a cost column in the CSV
  export. (#39)
- **Playwright smoke suite** — headless Chromium against the standalone mock,
  one spec per conformance fixture, on every PR. (#36)
- Theme picker (6 themes) and a keyboard-shortcuts overlay. (#40)

### Changed

- `web/state/` observable-store refactor — behaviour-preserving, and what
  unblocked everything above. (#34)

## [0.2.1] - 2026-07-21

Static asset bundle; no user-visible change beyond the republished artifact.

## [0.2.0] - 2026-07-20

First release of `mast-web-<tag>.tar.gz` as the canonical artifact for
downstream agent binaries to fetch and embed via `go:embed`. See
[`docs/web-design.md`](docs/web-design.md) for how the embedding works.

[Unreleased]: https://github.com/go-steer/mast-web/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/go-steer/mast-web/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/go-steer/mast-web/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/go-steer/mast-web/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/go-steer/mast-web/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/go-steer/mast-web/releases/tag/v0.2.0
