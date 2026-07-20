# mast-web: upstream drift audit (2026-07-16)

**Status:** dated one-shot audit. Snapshot of how core-agent, core-tui, and the new mast repo have moved since mast-web's design docs were last cut (`web-design.md` 2026-06-13, `web-bootstrap.md` 2026-06-12). Enumerates broken assumptions, stale cross-references, and features that are now consumable rather than notional. Rots the moment mast-web's design docs are reconciled — the intent is to be deletable after two focused PRs (docs reconcile + attach-client refresh).

Not a plan. A delta.

---

## TL;DR

- **Wire protocol is now `1.2.0`** in code and spec (mast-web cites v1.1.0). The event names in our design doc (`assistant_text`, `cost_update`) are wrong — real names are hyphenated (`status-update`, `usage-update`, `turn-complete`, `turn-error`, `inbox`, `agent`, `capabilities`). Streaming/tool sub-types multiplex on the legacy `agent` frame.
- **Phase C★ (`--ui` flag) has shipped on core-agent's side.** mast-web docs list it as "Planned (PR against `go-steer/core-agent`)". The full stack — `--ui` / `--ui-dir` / `.mast-web-version` / `internal/webui/dist/` / `dev/tools/fetch-mast-web` — is live in core-agent with public docs at `docs/site/content/docs/reference/web-ui.md`.
- **The mast repo exists but is docs-only, pre-code-fork.** Design corpus migrated from `core-agent/docs/mast/` (which was deleted) and expanded by 12 new design docs. All mast-web cross-references to `core-agent/blob/main/docs/mast/*` are broken. Correct pattern: `github.com/go-steer/mast/blob/main/docs/*`.
- **Multi-session backend is more capable than we assumed** — session-resume, idle eviction with silent status flip, `DELETE /sessions/{app}/{sid}`, per-turn cost with cache attribution, cost-ceiling `turn-error`. Phase D's "multi-session sidebar" is mostly a wiring exercise now, not a design one.
- **New client-facing surprises:** `PermanentStreamError` (404/401/403 → stop reconnecting), `usage-update.last_turn` as authoritative per-turn cost, `latency_ms` on tool-result payloads, `capabilities` frame as first-frame-with-version.

---

## 1. Wire protocol delta (v1.1.0 → v1.2.0)

Spec: [`core-tui/docs/sse-event-stream-protocol.md`](../../core-tui/docs/sse-event-stream-protocol.md), changelog dated 2026-07-16. Version constant: `pkg/attach/events.go:37` — `ProtocolVersion = "1.2.0"`. The design doc's working name **"v1.5.0"** in `attach-mode-design.md` is a *feature-bundle* label, NOT the wire version. Ignore it.

### 1.1 Event names — our doc has these wrong

| mast-web design doc says | Actual name on the wire |
|---|---|
| `assistant_text` | (doesn't exist as a top-level event) — streaming text rides `agent` frame as `stream-chunk` |
| `tool_call` | `tool-call` sub-type on `agent` frame |
| `tool_result` | `tool-result` sub-type on `agent` frame (payload now carries `latency_ms` inside the response map, v1.2.0) |
| `turn_complete` | `turn-complete` |
| `cost_update` | (doesn't exist) — per-turn cost is `usage-update.last_turn` (added v1.1.1, #249) |

**Names are hyphenated, not snake_case.** Full authoritative list:
- `capabilities` — MUST be first frame. `{protocol_version, event_types, server}`. Clients that key off protocol version read it here.
- `status-update` — **merge semantics**: absent fields = unchanged; only `turn_state` is required. Fields: `model, provider, perm_mode, turn_state ∈ {idle, streaming, awaiting_permission, awaiting_elicit}, context_pct`.
- `usage-update` — `{tokens_in_total, tokens_out_total, cost_usd_total, turns_total, by_model{}, last_turn?}`. **`last_turn` is the authoritative per-turn cost source** with cache attribution: `{tokens_in, tokens_in_cached?, tokens_out, cost_usd, model}`.
- `inbox` — `{state ∈ {queued, dequeued}, prompt_id, queued_at}`. **Fires twice per prompt.** Coalesce/dismiss the "queued" toast on `dequeued`.
- `turn-complete` — `{prompt_id, model, tokens_in, tokens_out, cost_usd?, latency_ms}`. `cost_usd` is now **optional** (v1.1.0); fall through to next `usage-update.last_turn` if absent.
- `turn-error` — `{kind, code?, message, retryable, hint?}`. **New kind: `cost_ceiling`** (`retryable=false`) — session refuses further turns until server-side reset. No `turn-complete` fires for the failed `prompt_id`.
- `agent` — legacy multiplexed wire event carrying an ADK `session.Event`. Still emitted for agents that don't implement `EmitTarget`. **Logical sub-types (`stream-chunk`, `tool-call`, `tool-result`) ride here.** Not going away.

Ordering guarantee: `turn-complete` always precedes its matching `usage-update` for the same `prompt_id`.

### 1.2 New payload fields worth surfacing

- **`usage-update.last_turn.cost_usd`** — server-side pricing has already applied cache-discount + operator overrides. This is what `/stats` per-turn and any per-turn footer should render, not `turn-complete.cost_usd`.
- **`usage-update.last_turn.tokens_in_cached`** — cache attribution; useful for the cost view.
- **`usage-update.by_model`** — per-model breakdown (`{tokens_in, tokens_out, cost_usd, turns}` keyed by model ID). core-tui's `/stats` renders this only when `len > 1`, sorted by descending cost.
- **`tool-result.response.latency_ms`** — per-tool-call latency. **Sidecar key inside the response map**, not a top-level field (ADK constraint per §2.7 of the spec — `tool.Run` can't write `CustomMetadata`). JSON decodes as `float64` in browsers, `int64` in Go; handle both.

### 1.3 Forward-compat contract (unchanged, worth restating)

Unknown event names, unknown `turn_state`/`inbox.state`/`turn-error.kind` values, and unknown payload fields **MUST be tolerated silently**. Spec §2 requires this — clients that fail on unknowns break on every server upgrade.

---

## 2. HTTP endpoint delta

Canonical path shape: `/sessions/{app}/{sid}/…`. The `/sessions/{sid}` shortcut works but returns **409 on ambiguous sid** (>1 app/user share a sid). **Prefer qualified in mast-web** — the shortcut is a single-tenant convenience.

### 2.1 New endpoints since 2026-06-13

| Method + path | Purpose | Notes |
|---|---|---|
| `POST /sessions` | Create owned session | Returns `{app, user, sessionID, url}` (201). 401 if anonymous, 501 if daemon has no `SessionFactory`, 409 on sid collision. Powers a "+ New" button. |
| `DELETE /sessions/{app}/{sid}` (+ shortcut) | Real hard delete | 204; closes SSE subscribers cleanly (EOF). Requires `SessionAdmin`. **403 on bootstrap `default` session** — guard this in UI. Resolves open question 2 (`/wipe` semantics). |
| `POST /sessions/{app}/{sid}/interrupt` | Soft-cancel current turn | Header `X-Interrupted: nothing-in-flight` when idle; 412 if agent lacks `InterruptProvider`. |
| `GET /sessions/{app}/{sid}/usage` | Rich per-turn + cache | `{overall, per_model, per_turn[{cost_usd_uncached_reference, input_tokens_cached, thoughts_tokens, tool_use_tokens, …}], digest_methods}` (#222/#248). |
| `GET /sessions/{app}/{sid}/{tools,agents,status,context,memory,skills,mcp,pricing,perms}` | Sidebar data | All read-only. Backing surface for our sidebar sections. |
| `POST /sessions/{app}/{sid}/perms/{allow,deny}` | Batch perm decisions | `{patterns}` body. |
| `GET /sessions/{app}/{sid}/perms/stream` + `POST .../perms/respond` | Interactive perm prompts | SSE event named `prompt`; respond with `{id, decision}`. |
| `POST /sessions/{app}/{sid}/pricing/{refresh,set}` | Operator pricing overrides | `{model, input_usd_per_mtok, output_usd_per_mtok}` for `set`. |
| `POST /sessions/{app}/{sid}/reload` | Config/agent reload | — |
| `POST /sessions/{app}/{sid}/slash/{compact,done,btw,subagent,replan}` | Server-side slash commands | Where `/compact`, `/done`, etc. now live. |
| `GET /.well-known/agent-card.json` | Unauthenticated A2A card | Bypasses auth middleware. |

### 2.2 Changed shape

- **`GET /sessions` returns a union** (#178 ε.4): `sessions:[{app, user, sessionID, has_event_log, status ∈ {active, idle}, last_touched_at}]`. ACL-filtered. This is the sidebar's data source.
- **SSE endpoint returns 412 Precondition Failed** (not 404) when the session has no eventlog.
- **`POST /wake` with `target != ""` currently 501s** — target-specific wake is spec'd but unimplemented. Don't lean on it.
- **`--attach-readonly` gates every non-GET method globally**, including `/interrupt`, `/perms/respond`, `/slash/*`. Expect blanket 403 on writes; degrade UI accordingly.

### 2.3 Auth surface

No new schemes. Additive:
- **`X-Attach-Token`** side-channel header — checked **before** `Authorization`. For IAP / Cloud Run IAM / Cloudflare Access deployments that own `Authorization`.
- **`X-Asserted-Caller`** (bot-on-behalf-of-human) — honored only when the resolved Caller is on the proxy allowlist. Relevant if mast-web ever fronts a workflow bot.
- **404 masks both not-found and ACL-deny** (existence hidden). Client can't distinguish "session gone" from "you're not authorized" from a 404.

### 2.4 Observability

- **W3C `traceparent`** (#237): server extracts via `otelhttp.NewHandler` and starts a span. Purely additive for clients — mast-web **MAY** send `traceparent`/`tracestate` to stitch browser traces to the daemon's. Nothing required.

---

## 3. Session lifecycle a client must model

Reference source of truth: `core-agent/docs/site/content/docs/reference/multi-session.md` (canonical). The design doc `core-agent/docs/multi-session-design.md` still says "shipped in v2.4 (2026-06-12)" but real behavior is v2.7-era — treat the design doc as historical intent.

- **Idle eviction is silent.** No push event fires when the sweep runs. Sessions **do not disappear** from `GET /sessions` (with ACL enforced) — `status` flips from `"active"` to `"idle"` and `last_touched_at` freezes. Clients infer via polling `/sessions` or by opening a stream (see next bullet).
- **Attach-to-idle triggers lazy resume.** First `GET /sessions/{app}/{sid}/events` on an idle session transparently runs `SessionResumer` (singleflight-deduped). Expect a one-time latency spike (~50 ms). No client action required.
- **Evicted-then-still-attached streams close.** An active SSE reader on a session that gets evicted sees channel-close EOF, not a typed frame.
- **Delete** → 204, all subscribers get EOF.
- **Bootstrap `default` session is undeletable** — 403. UI must guard.
- **There is no explicit `/attach`, `/resume`, or `/switch` endpoint.** Attach == open SSE on `/events`. Switch == open SSE against a different sid. Resume == implicit on first touch of an idle session.

---

## 4. `PermanentStreamError` — new terminal-error contract

Not a wire event — a client-side classification. Duck-typed interface `PermanentStreamErr() bool` on returned errors (`core-agent/internal/attachclient/status_error.go`, `core-tui/tui/agent.go:190-205`).

**Wire signal for mast-web:** HTTP status on the failing SSE reconnect.

| Status | Class | Client action |
|---|---|---|
| 404 | Permanent (session evicted/deleted or ACL revoked; 404 masks both) | Stop retrying. Surface terminal banner: *"Session unavailable. Reconnect with a new session."* |
| 401 | Permanent (token revoked/expired) | Stop retrying. Prompt to re-auth via first-run modal. |
| 403 | Permanent (ACL revoked) | Stop retrying. Same terminal banner as 404. |
| 5xx / 429 / transport | Transient | Keep the reconnect loop with backoff. |

core-tui's fallback substring heuristic scans for `"status 404"`, `"status 401"`, `"status 403"` when the error type isn't wrapped. Mirror-worthy pattern.

Currently mast-web's reconnect (or the stub of it) reconnects on every error. **This is a bug the moment we run against a real backend that deletes sessions.**

---

## 5. `--ui` flag: Phase C★ has shipped upstream

Design doc lists Phase C★ as "Planned (PR against `go-steer/core-agent`)". Reality:

- **Docs:** `core-agent/docs/site/content/docs/reference/web-ui.md` (public — covers `--ui`, `--ui-dir`, `.mast-web-version`, auth+TLS story, when-not-to-use section).
- **Implementation:**
  - `core-agent/cmd/core-agent/main.go` — `--ui` and `--ui-dir` flags
  - `core-agent/pkg/attach/handlers_ui.go` + `handlers_ui_test.go`
  - `core-agent/pkg/attach/server.go` — mount at `/ui/*`
  - `core-agent/internal/webui/webui.go` — the `//go:embed all:dist/*`
  - `core-agent/.mast-web-version` — top-level pin file (open question 6 → resolved as "plain top-level file")
  - `core-agent/dev/tools/fetch-mast-web` — the build-time fetch script

Behavior worth internalizing:
- Refuses to start with a clear error if the embedded bundle is empty (didn't run `fetch-mast-web`).
- `--ui-dir` implies `--ui`; serves whatever's in the directory at request time (no rebuild loop needed when editing `web/app.js`).
- Inherits the attach listener's TLS + auth boundary — one cert, one token, one origin.

**Implication for mast-web docs:** the Phase C★ row of the deployment-options table needs to flip from "Planned" to "Shipped" with a link to the core-agent web-ui reference doc. web-bootstrap.md's Phase C description also needs updating — the doc still frames Phase C as "`go:embed` integration" as if pending.

---

## 6. The `mast` repo — docs-only, pre-code-fork

Location: `/home/user/projects/mast` → `github.com/go-steer/mast`.

- **State:** docs-only. 7 commits, all docs. Head `a84b5a9` (2026-07-11). No tags, no releases. No `go.mod`, `cmd/`, `pkg/`, `internal/`. README status: "**pre-fork**".
- **The core-agent → mast docs migration already executed.** `core-agent/docs/mast/` **no longer exists** — `ls` returns not-found.
- **New URL pattern for docs cross-refs:** `https://github.com/go-steer/mast/blob/main/docs/<file>.md` — same filenames.
- **The doc corpus expanded significantly.** In addition to `positioning.md`, `fork-design.md`, `specialists-design.md`, mast now has: `a2a-design.md`, `ag-ui-design.md`, `config-layout-design.md`, `deployment-design.md`, `durable-execution-design.md`, `federation-design.md`, `library-api-design.md`, `mcp-catalog-design.md`, `memory-design.md`, `observability-design.md`, `orchestration-design.md`, `skills-design.md`, `workload-scaffolding-design.md`.
- **`fork-design.md` was revised 2026-07-01** — phase-1 fork will *rebuild* the loop against ADK v2, not prune-in-place. Bucket 2 (adapters incl. attach) still ports over. Task classes are now `chat / debug / implement / research / review / orchestrate` (SingleTurn is internal).

### 6.1 Design surfaces mast-web contributors should know exist

Not client-actionable today, but shape the horizon:

- **AG-UI** (`ag-ui-design.md`, 2026-07-11) — a *fourth* protocol surface alongside attach. mast plans to be both AG-UI server (CopilotKit apps + Slack/Teams/Discord/Telegram/WhatsApp bots) and client. Attach isn't the only wire mast-web could speak long-term. Interrupt lifecycle (`RunFinished{interrupt}` / `RunAgentInput.resume`) reuses mast's durable pause/resume — worth glancing at if mast-web ever grows an interrupt/resume UI.
- **Skills subsystem** (`skills-design.md`) — first-class `SKILL.md` support coexisting with specialists. `GET /sessions/{app}/{sid}/skills` already exists in attach; the returned shape will fatten.
- **Workload bundles** (`.agents/workloads/*.yaml`, per `orchestration-design.md`) — operator-authored dispatch profiles. Task-router UI territory.
- **Durable execution** (`durable-execution-design.md`) — programmatic pause, timed pause, external-signal pause, snapshot+replay. More expansive than HITL — worth watching for what new event kinds appear on the wire.
- **Federation** (`federation-design.md`) — mast-to-mast handoff, cross-instance session state. If mast-web ever wants a "session on a peer instance" affordance, this is the substrate.
- **Multi-tenant memory keyspace** (`memory-design.md`) — session/tenant/global scopes with per-tenant opt-in. `/memory` endpoint's returned shape gains scoping.
- **Deployment topologies** (`deployment-design.md`) — Cloud Run, GKE, library-embedded, standalone. mast-web's four deployment shapes need to compose with these, not conflict.
- **Extension surfaces** (`library-api-design.md`) — includes **attach transports** as an extension seam. Relevant if mast-web ever needs a non-default transport (WebSocket, WebTransport, whatever).

---

## 7. core-tui as reference implementation — patterns worth mirroring

core-tui shipped concrete patterns for problems mast-web hasn't hit yet but will. Steal freely.

### 7.1 Session generation counter (multi-session correctness)

`core-tui/tui/agentcmd.go:229` — every emitted `Msg` carries the `sessionGen uint64` captured at goroutine start; the update loop drops stragglers with `if msg.gen != m.sessionGen { drop }`. Prevents in-flight events from the outgoing session appearing after a `/switch`. **mast-web needs the same pattern** in its event handling — bare `addEventListener`/`onmessage` will paint stale data into the new session's view.

### 7.2 Switch-in-place is *not* delete

core-tui's `/switch` closes local contexts (turn/slash/live-stream) and swaps replaceable subsystems (`UsageTracker`, `Memory`, `Skills`, `MCPServers`, `Branding`, `Note`) atomically. **Does NOT DELETE the outgoing server session** — it detaches. Same posture for mast-web: switching between sessions in the sidebar closes the SSE reader and opens a new one against a different sid, without touching the outgoing daemon-side state.

### 7.3 Refresh EVERYTHING on switch (lesson from bug #274)

When switching, refresh `/usage`, `/memory`, `/skills`, `/mcp`, and branding/identity — not just the event stream. Otherwise the sidebar keeps showing the outgoing session's data. This was a real bug in core-tui; don't repeat it.

### 7.4 Expandable tool-call detail overlay (Ctrl+X)

`core-tui/tui/dialog_toolcall.go` + `tool_detail.go`. Modal keyed off the most-recent tool call. ← / → walk through history, ↑ / ↓ scroll body, Home/End jump, Esc closes. Header: `"3/8 · read_file · id abc123 · [2.4s] ✘ failed"`. Body: pretty-printed JSON `args:` + `response:` (or error banner), scalars capped at 4000 bytes/line, 400 lines/section.

Info the collapsed view doesn't have: full argument map, full response map (up to caps), full error text, wire-level call ID, per-call latency chip. All rendered from data already on the wire (`ToolArgsMap`, `ToolResponseMap`, `ToolError`, `ToolLatencyMs`). **Worth mirroring** — a standard operator debugging surface.

Verbose mode (`Options.ToolDetailVerbose=true`) inlines the same block into every transcript tool row.

### 7.5 Observer mode

`LiveAgent` capability. Client subscribes to a single long-lived `Events(ctx)` iterator instead of per-turn `Run()`. No turn-boundary knowledge on the client side, so `finalizeTurn()` never fires — footer would be blank. Fix: `StampLatestAssistantFooter` walks back to the tail `RoleAssistant` entry on every `turn-complete` and fills `Model/Usage/Elapsed`; on every `usage-update.last_turn`, stamps authoritative `cost_usd`. Fills only currently-zero fields so it can't clobber.

Observer banner text varies by `InjectableAgent` capability:
- Read-only: *"Attached as observer — agent runs autonomously; events stream below."*
- Read-write: *"Live session — your messages drive the agent; events stream as they happen."*

Relevant to mast-web the moment we have a passive-observer use case (an SRE dropping in on a running incident-triage session).

### 7.6 Per-model stats

`core-tui/tui/slash_builtin.go:802-884` — `/stats` prefers push data (`usage-update.by_model`) over local tracker; skips the breakdown when `len <= 1`; sorted by descending `cost_usd`, tie-broken by descending `tokens_out`, then name. Row format: `"Models:     gemini-2.5-pro (3 turns, 5557 in / 123 out, $0.0126)"` with `"+ "` prefix on subsequent lines. Directly portable.

---

## 8. What mast-web should react to

### 8.1 Docs (fast, low-risk)

Two-doc PR against mast-web:

- **`docs/web-design.md`, `docs/web-bootstrap.md`, `docs/README.md`:** replace every `github.com/go-steer/core-agent/blob/main/docs/mast/*` URL with `github.com/go-steer/mast/blob/main/docs/*`. Same filenames.
- **`docs/web-design.md`:** bump protocol version from "v1.1.0" to "v1.2.0"; fix event names in the "port app.js" and "reuse from cogo-wasm2" tables; replace "docs/multi-session-design.md v2.4" with a link to `core-agent/docs/site/content/docs/reference/multi-session.md`.
- **`docs/web-design.md` deployment-options table:** flip Phase C★ row from "Planned" to "Shipped"; link to the core-agent web-ui reference doc.
- **`docs/web-bootstrap.md` Phase C section:** clarify that "`go:embed` integration" (originally Phase C, now Phase C★) has landed on core-agent's side; mast-web's remaining work in that phase is the release-pipeline half, which the git log shows is also done.
- **Add a "Related" pointer** to mast's AG-UI design doc, so future mast-web contributors know attach isn't the only wire mast will speak.
- **Update open questions:** #2 (`/clear` semantics) is resolved by `DELETE /sessions/{app}/{sid}`. #6 (`.mast-web-version` format) is resolved by core-agent's implementation.

### 8.2 Attach client (`web/attach-client.js` + `web/app.js`)

Real code changes needed to keep the current Phase B implementation from breaking against a v1.2.0 backend:

1. **Rename event handling to hyphenated names.** Parse `capabilities` as the first frame; use its `protocol_version` to gate feature detection. Merge-semantics `status-update` (absent = unchanged). Coalesce `inbox` events on `dequeued`.
2. **Route per-turn cost through `usage-update.last_turn`**, not `turn-complete.cost_usd` (which is now optional). Surface `tokens_in_cached` in the cost view.
3. **Extract `latency_ms` from `tool-result.response`** (sidecar key inside the response map, not a top-level field). Render it in the tool-call chip. Handle both `float64` (browser) and `int64` (from Go-serialized replays).
4. **`PermanentStreamError` classification.** On reconnect failure: 404/401/403 → stop retrying, show terminal banner. Everything else → keep the current backoff loop.
5. **`turn-error` handling.** Especially `kind="cost_ceiling"` → persistent banner + disable input. Recognize that no `turn-complete` will follow.
6. **Per-model breakdown in `/stats`** from `usage-update.by_model`. Portable format from core-tui's `slash_builtin.go:802-884`.

Nice-to-have (not blocking):

- W3C `traceparent` forwarding on outgoing requests (browser-side trace stitching).
- Handle `X-Interrupted: nothing-in-flight` header on `/interrupt` gracefully (no-op the UI feedback).

### 8.3 Multi-session sidebar (Phase D — feasibility check)

**Backend is ready.** The Phase D "multi-session sidebar" is no longer a design problem, it's a wiring exercise.

Already consumable via existing endpoints:
- Sidebar list from `GET /sessions` (union with `status` + `last_touched_at`).
- "+ New" button → `POST /sessions`.
- Row-level delete → `DELETE /sessions/{app}/{sid}` (guard `default`).
- Idle/active badge from the `status` field. Sort by `last_touched_at`.
- Session-scoped SSE reconnect works transparently against an idle row (server auto-resumes).

Still needs mast-web design work:
- **Switch-in-place UX** — refresh usage/memory/skills/MCP/branding at the same instant the event stream swaps (lesson from bug #274). No client-side `applySwitchTarget` equivalent yet.
- **Session generation counter pattern** (§7.1) — required to not paint stale-goroutine events into the new session's view. This is a correctness requirement, not a nice-to-have.
- **Cost-ceiling banner + reset affordance** — no client-side reset endpoint exists. Needs either a server-side slash command (`/reset-ceiling`?) or manual daemon-side action. TBD.
- **Cross-daemon `/attach <url>` analog** — a URL bar or "add daemon" dialog. `GET /peers` on the current daemon enumerates registered peers; core-tui does parallel fan-out with a 5s per-peer budget.
- **404 vs 500 disambiguation on session click-in** — 404 = gone or unauthorized (do NOT distinguish; server hides existence); 500 = resume failed, retry.

### 8.4 Deferred / not-for-this-round

- **AG-UI as a second consumer protocol.** Only relevant if/when mast ships AG-UI server-side. Current mast-web scope is attach-only.
- **Federation UI** (peer instance handoff, cross-instance session state). Backend design isn't code yet.
- **Skills / workload / durable-execution surfaces.** Wait for the shape to stabilize in mast; endpoints don't fully exist yet.

---

## 9. Broken cross-references (checklist)

Concrete grep hits to fix as part of §8.1:

- `docs/README.md` — 3 refs to `core-agent/blob/main/docs/mast/{positioning,fork-design,specialists-design}.md`. Also the intro paragraph "which doesn't exist as a repo yet — it forks from core-agent per the plan in [fork-design.md]…" — mast exists (docs-only, pre-code-fork).
- `docs/web-bootstrap.md` — 4 refs to `core-agent/…/docs/mast/*`. Also outdated language treating mast as future ("`~/projects/mast/docs/positioning.md` (after the fork)") — the docs fork already happened, the code fork hasn't.
- `docs/web-design.md` — 4 refs (fork-design ×1, positioning ×2, specialists-design ×1). Also the "Migrated from `core-agent/docs/mast/web-design.md`" note in the status line.

Framing to preserve when rewriting: "docs fork already happened; code fork hasn't yet — mast is docs-only pre-alpha." That's the accurate two-state framing.

---

## 10. Rot conditions

Delete this doc when:
1. The two-doc PR from §8.1 has merged (docs no longer stale).
2. The attach-client refresh from §8.2 has merged (code no longer broken vs v1.2.0).

Everything in §7 (core-tui patterns) is evergreen but belongs in a real design doc, not an audit — either fold into web-design.md's "what we reuse" table or add a `docs/patterns-from-core-tui.md` and link from there.
