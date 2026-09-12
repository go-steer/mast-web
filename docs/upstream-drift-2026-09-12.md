# mast-web: upstream drift audit (2026-09-12)

**Status:** dated one-shot audit. Snapshot of what `core-tui` has shipped since mast-web's docs were last reconciled against it (`web-design.md`, 2026-07-20, which cites core-tui#68 as its high-water mark). Enumerates the wire-contract drift, the feature work that changes the shape of v0.4 PRs already on the board, and — explicitly — the large fraction that is terminal-specific and which we should not track. Rots when the protocol catch-up lands and `web-design.md` / `v0.4-plan.md` are reconciled.

Not a plan. A delta. The precedent is [`upstream-drift-2026-07-16.md`](https://github.com/go-steer/mast-web/blob/be86879/docs/upstream-drift-2026-07-16.md), deleted after the v0.2 reconcile, which is the intended fate of this one.

---

## Sync point

`web-design.md` says "last reconciled 2026-07-20" and names core-tui#68 — the v1.4.0 spec PR — as the newest thing consumed. core-tui's own history agrees: #68 is dated 2026-07-20 and everything from #69 onward is new to us.

| | Then | Now |
|---|---|---|
| core-tui release | v0.16.1 (2026-07-18) | v0.24.0 (2026-08-30) + unreleased |
| Attach wire protocol | 1.4.0 | **1.7.0** |
| Commits | — | ~130, 2026-08-11 → 2026-08-31 |

Eight releases. The protocol moved three times.

---

## TL;DR

- **Our stop button silently parks the agent.** At 1.5.0, `POST /interrupt` changed its default from *cancel* to *park*. We send no `hold` flag, so against any current core-agent an operator pressing stop wedges the session behind a gate no mast-web surface can see or open. This is a live bug, not a parity gap, and the spec names it as the revision's sharp edge. §1.1.
- **Two event types we drop on the floor** — `pause` (1.5.0) and `wake` (1.7.0). Neither string appears in `web/attach-core/`. §1.2, §1.3.
- **1.6.0 added an optional `title` to session rows** and we render `id · app` instead. §1.4.
- **`features.guardrails` is now documented** — we call the guardrails endpoints already but gate on nothing. §1.5.
- **Six core-tui features change the target shape of v0.4 PRs already filed** (#59, #60, #63), rather than adding PRs. Chiefly: `/tools` grouped by source, the slash catalog/invoke split, and `/permissions` carrying `by`. §2.
- **Operator hold (core-tui#260) is the largest single addition and has no slot on our board.** It is the UX half of the §1.1 bug. §2.2.
- **Most of the 130 commits are not ours.** Mouse capture, terminal row budgeting, Chroma memoization, the Go exported-API freeze. §3 says so explicitly so the next sync does not re-triage them.

---

## 1. Wire protocol delta (v1.4.0 → v1.7.0)

Spec: [`core-tui/docs/sse-event-stream-protocol.md`](https://github.com/go-steer/core-tui/blob/main/docs/sse-event-stream-protocol.md) §8, caught up in core-tui#272 (2026-08-20). Three bumps landed on the producer side before the spec documented any of them, which is why a single PR moved the header from 1.4.0 to 1.7.0.

| Version | Date | What changed |
|---|---|---|
| 1.5.0 | 2026-08-19 | `pause` event (§2.8), `features.pause`, `/interrupt` parks by default, `POST /pause` + `POST /resume`. Shipped in core-agent#794. |
| 1.6.0 | — | No frame changed. Optional `title` on the producer's session rows. |
| 1.7.0 | — | `wake` event (§2.9). Shipped in core-agent#809. |

`features.guardrails` was backfilled in the same pass — producers have advertised it since core-agent#670 without a bump, which §2.1's additive rule permits.

### 1.1 The live bug: `/interrupt` now parks unless told otherwise

`web/attach-core/client.js:621` sends a bare body:

```js
async interrupt() {
  const path = '/sessions/' + encodeURIComponent(this.sessionId) + '/interrupt';
  const r = await fetch(this.endpoint + path, {
    method: 'POST',
    headers: { ...this._headers(), 'Content-Type': 'application/json' },
    body: '{}',
  });
```

At 1.5.0 that means *park the loop*, not *cancel the turn*. The spec's §4 compatibility matrix spells out the consequence for a client in exactly our position:

> Pre-1.5.0 client | 1.5.0 server | `pause` frames arrive under an event name the client doesn't know and are dropped. The gate is still real, and that is the sharp edge of this revision: the server parks on `POST /interrupt`, the client that asked to cancel sees only a cancel, and nothing on its screen says a resume is owed. Producers MUST therefore honour `hold=false` on `/interrupt` for callers that ask for it, so a client written against 1.4.0 semantics can keep getting them.

We are the client that has to ask. Every mast-web surface is affected — `web/terminal.js:1453` (solo + spatial) and `web/app.js:2927` (classic) both call `client.interrupt()`.

**Fix:** send `{"hold": false}`. One field, no dependency on the state seam or on any other v0.4 work. Worth landing ahead of the rest of the catch-up.

The paired affordance — letting the operator *deliberately* hold — is §2.2 and is a much larger piece of work.

### 1.2 `pause` (v1.5.0+) — unconsumed

Not in the typed-event list at `web/attach-core/client.js:501-508`, which still reads:

```js
const typed = [
  'capabilities', 'status-update', 'usage-update',
  'inbox', 'turn-complete', 'turn-error',
];
```

Payload per §2.8:

| Field | Type | Req | Notes |
|---|---|---|---|
| `state` | string | yes | `"paused"` / `"resumed"`. Unknown values are no-ops, not guesses. |
| `reason` | string | no | Human-readable, shown verbatim — `"operator interrupt"`, `"cost ceiling reached"`. |
| `interrupted` | bool | no | `paused` only. Whether a turn was actually killed on the way in. "Your work was killed" vs "the loop just won't start" is the first thing an operator asks. |
| `mode` | string | no | `resumed` only. `"steer"` / `"continue"` / `"abandon"`. |
| `at` | RFC 3339 | yes | Transition time. |

Three consumer rules worth writing into the client rather than rediscovering:

1. **Gate on two different things.** Render *received* pause state off `"pause"` in `event_types`; offer a pause/resume *control* off `features.pause`. A 1.5.0 server lists the event whether or not the agent behind it can actually hold, so conflating them offers a park that never happens.
2. **Emitted by the agent, not the handler** — so a park driven in-process reaches us, and a second operator parking the session shows up without polling. This is a multi-watcher correctness property, which matters for us specifically given PR 6's multi-user work.
3. **Push beats a contradicting poll for a settle window.** `GET /status` also reports `paused_since` / `pause_reason` / `interrupted`, which is how a client attaching to an already-paused session renders the banner. core-tui uses two seconds, then lets the server win — a client that ignores the poll forever stays wrong after a missed event.

The REST half (`/pause`, `/resume`, `/interrupt`'s `hold`, `/status`'s new fields) is **not** specified in that document — it has never covered the reverse direction. [core-tui#270](https://github.com/go-steer/core-tui/issues/270) is where that gap gets closed. Until it does, the schemas come from core-agent.

### 1.3 `wake` (v1.7.0+) — unconsumed, and easy to get wrong

Payload is `at` and nothing else. Note this is **not** our existing `POST /sessions/{sid}/wake` (`client.js:605`) — that is the request half, and unrelated.

The spec is unusually emphatic about the one thing a client gets wrong unaided:

> **a wake does not mean an alert is waiting.** Client copy that asserts inbox contents on the strength of this event is wrong for every wake that isn't alert-driven.

core-tui shipped exactly that bug and fixed it in #272 — their row claimed "an external alert is waiting in the inbox", which is false for a plain scheduler-driven "look now". `reason` is specified **absent, not reserved**: the in-process signal is a bare channel with no payload, so no producer could fill it.

Further semantics: it is an edge, not a state (nothing to reconcile on reconnect); coalescing is promised in neither direction, so treat it as an edge and not a count; and an operator-typed prompt does *not* produce one, since the inject already announces itself as `inbox`.

### 1.4 Session `title` (v1.6.0)

`web/daemon-sidebar.js:198` builds row labels as `s.id + ' · ' + s.app + ' · ' + d.endpoint`. Producers can now send a `title`. Small, but it is the cheapest legibility win available to PR 5's sidebar work.

### 1.5 `features.guardrails`

We call `GET /guardrails` and `POST /guardrails/reset` (`client.js:718`, `:737`) and gate on nothing. The flag is now documented and means something distinct from `cost_ceiling`: *the operator can read and reset a tripped watchdog without restarting the agent*. Relevant to PR 3, which ports `/guardrails` into the surviving shells and is also where #45 (capability-gating the built-ins) gets fixed.

### 1.6 A trap we happen to dodge

core-agent classifies a cancelled turn's `context.Canceled` as `transient_network` with `retryable: true`, and a cancelled turn still closes on `turn-error`. A client wiring a retry button straight off `retryable` therefore offers to retry work the operator just stopped. `grep retryable web/` returns nothing outside vendor, so we are clean — worth keeping that way when PR 2/3 build out error affordances.

### 1.7 Stale in our tree

- `web/attach-core/protocol.js:34` — comment says "v1.3.0 will add features / slash_commands / agent / caller_id". That shipped in 1.4.0 and we consume it.
- `web/attach-core/client.js:16,20,56` and `web/state/session.js:19,63,153` — all say v1.4.0.
- `web/attach-core/conformance/fixtures/` has ten fixtures, none covering `pause` or `wake`. core-agent carries `wake-v1.7.0` and `rest-sessions-list-v2` fixtures; per the v0.2 plan's open question 6 we mirror rather than share, so these want local copies.

---

## 2. Feature delta that lands on the v0.4 board

None of these add a PR. They change what the already-filed PRs should be aiming at.

| core-tui | Ours | Why it changes the target |
|---|---|---|
| **`/tools` groups by source, counts, filters** ([#289](https://github.com/go-steer/core-tui/issues/289)) | **PR 2** (#59) | The flat alphabetical list was right for ~14 built-ins and wrong the moment hosts started reporting MCP servers and skills (core-agent#827). Header is now `Tools (59): builtin 14 · gke 31 · skill 9 · subagent 5`, headings per source over bare names, descriptions suppressed until `/tools <source>` asks for one. The gate annotation survives grouping where the description does not — "this one will stop and ask" changes what the operator does next; "reads a file" does not. Porting the flat shape ports something they already outgrew. |
| **Slash catalog ≠ one provider shape** ([#275](https://github.com/go-steer/core-tui/issues/275), [#276](https://github.com/go-steer/core-tui/issues/276)) | **PR 3** (#60), **#45** | An async-only host had no palette rows, no `/help` section, and `unknown command` on dispatch, because every listing path asked for the sync interface by name. Listing and invoking are decoupled now: the listing paths ask for the catalog, and *how* to run one is decided once at dispatch. Directly informs how we gate built-ins off `capabilities.slash_commands`. |
| **`/permissions` carries `by`** ([#277](https://github.com/go-steer/core-tui/issues/277)) | **PR 6** (#63) | core-agent's gate started attributing approvals in v2.9.0-dev (core-agent#830); history rows carry an optional `by`. Rendered as a ` by <who>` suffix, and **omitted entirely when empty** — no `by <unknown>` placeholder, because a placeholder in an audit line is indistinguishable at a glance from a name somebody checked. Worth copying that discipline. See also §4. |
| **`/resume` → `/transcripts`** ([#268](https://github.com/go-steer/core-tui/issues/268)) | **PR 3** built-ins | A naming collision, not a rename for taste: `/resume` belongs to `POST /resume`, the endpoint behind `/continue` and `/abandon`. The command wearing it listed transcript files off local disk. If we port a `/resume` built-in we inherit the collision they just paid to fix. |
| **Subagent turn drill-down** ([#70](https://github.com/go-steer/core-tui/issues/70)) | **PR 2** (#59) | `getSubagentEvents` is on our port list with no reference rendering. There is one now — overlay plus live inline tail. |
| **The agent can ask the operator a question** ([#255](https://github.com/go-steer/core-tui/issues/255)) | unscheduled | A new direction of traffic, distinct from permission prompts and elicitation. No mast-web equivalent and no slot; noting it so it is not discovered late. |

### 2.2 Operator hold — the one with no home

[core-tui#260](https://github.com/go-steer/core-tui/issues/260), shipped across v0.23.0 and hardened in four follow-ups (#278, #280, #281, #299). The largest single thing core-tui added in this window, and v0.4 does not mention pause or hold anywhere.

What it is: Esc stops the agent and waits, whether or not a turn was running. A banner above the input says whether your work was killed or the loop is merely parked, what the host gave as a reason, how many background subagents are still running, and the three ways out. Typing while held *steers* — Enter sends the text as the new instruction rather than starting a turn that would block on the gate forever. `/continue` carries on, `/abandon` drops the interrupted work, `/pause` shuts the gate without interrupting anything.

Two hard-won details from their follow-ups, both of which we would otherwise rediscover:

- **A held input box is a steer field, so something must decide whether a leading `/` is a command or prose.** They asked the wrong question twice (is this slash *safe mid-turn?* — a different question from *is this a command?*) and shipped a bug where an operator who parked a misbehaving agent and typed `/quit` reopened the gate and handed the agent `"/quit"` as its new instruction. The command's effect exactly inverted, at the moment an operator is most likely to reach for it. The fix was to make the built-in name list its own thing rather than a subset of the mid-turn allowlist.
- **Who runs the steer depends on who owns the loop, and getting it wrong is silent.** A host driving its own loop takes the steer and its standing event stream shows the turn; a per-turn host has no such stream, so the gate opens with `abandon` and the client runs the text itself. Send a per-turn host a steer and the operator watches their prompt land and then silence — which is the exact thing the hold exists to make impossible. mast-web is on the standing-stream side, so this resolves for us, but it needs to resolve deliberately.

**Recommendation: not v0.4.** v0.4's stated purpose is reducing surface area, and this adds a banner, three commands, and a second input mode. It is a v0.4.1 candidate, filed now so it is a decision rather than an oversight. The §1.1 one-liner is what makes v0.4 *correct* without it.

---

## 3. Explicitly not relevant

Recorded so the next sync does not re-triage 130 commits.

- **Terminal mechanics** — mouse capture hints and `/mouse` persistence (#288/#287), terminal row/chrome budgeting (#103, #121, #132), frame clipping (#102), tab expansion before wrap (#217), CJK/emoji caret placement (#125), hardware cursor parking (#105). All answer questions a browser answers for us.
- **Rendering performance** — Chroma lexer memoization (#106), 20 fps spinner paused off-screen (#248), re-wrap once per drag (#247), render memo hit path (#204), transcript addressed by item (#161). Our equivalents are DOM-shaped and unrelated.
- **Go API surface work** — `Model` unexported / `NewModel` returns `tea.Model` (#115), capability consolidation 20→16 (#77), 27 incidental symbols unexported (#78), `CursorDialog` / `ScrollDialog`, the apidiff CI gate. We consume a wire protocol, not a Go package.
- **Test infrastructure** — `tea.Program`-driven headless tests (#81), the frame-invariant grid (#158, #211), golden corpus and render benchmarks (#101).
- **Transcript gestures** — pan sideways (#154), select-and-fold (#152, #153), `y`/`c` copy (#153), `ClipboardWriter` (#175). Real UX work, but the browser gives us selection, scrolling and clipboard natively.
- **Terminal escape-sequence sanitization** (#108). The web analogue is XSS and we already escape (`web/terminal.js:105`). Worth naming because the *class* transfers even though the fix does not.

---

## 4. What this does to the roadmap

The v0.4 plan's "Sibling upstream (informational)" section calls per-turn caller attribution (`shells-design.md` §9) "still the one protocol ask, still upstream's to ship". That is now partly overtaken: core-agent#830 attributes **approvals** with an optional `by`, and core-tui#277 renders it. Identity is flowing back out on a per-decision basis for the first time. It is not per-turn speaker attribution — §2c's ask is unchanged — but it is a precedent to cite when re-raising it, and it lands in the same surface PR 6 is building.

Otherwise: §1 is a self-contained unit that blocks on nothing (notably not on PR 1's state seam) and can run parallel from day one alongside PRs 7 and 8. §2 is amendments to #59, #60 and #63. §2.2 is a scope call recorded rather than taken.

---

## Sources

- [core-tui CHANGELOG](https://github.com/go-steer/core-tui/blob/main/CHANGELOG.md) — v0.17.0 through v0.24.0 plus Unreleased
- [core-tui SSE wire protocol spec](https://github.com/go-steer/core-tui/blob/main/docs/sse-event-stream-protocol.md) — v1.7.0; §2.8, §2.9, §4, §8
- core-tui#272 (spec catch-up), #260 (operator hold), #289 (`/tools`), #277 (`/permissions by`), #275/#276 (slash catalog), #268 (`/transcripts`)
- core-agent#794 (pause gate), #809 (wake), #830 (approval attribution), #827 (tool sources), #802 (wake copy)
- Read against `core-tui@7eb7cbe` and `mast-web@6524cbe`.
