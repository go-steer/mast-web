# mast-web: shell architecture

**Status:** draft, 2026-08-16. Proposes the layer mast-web has been growing into without naming it: a shared core with **pluggable shells** on top, so the terminal console, a conversational chat surface, the spatial prototype, and a fleet dashboard are four presentations of one state model rather than four apps. Companion to [`web-design.md`](./web-design.md) (the architecture, evergreen) — this doc extends it; it does not replace it. Rots when the shell registry ships and the surviving content folds back into `web-design.md`.

## The question

Two things arrived at once:

1. We want mast-web to become a **proper dashboard for a fleet of mast agents**, not a single-session operator console.
2. We want a **chat UI as a first-class option**, the way the terminal console is an option today — and the spatial prototype on `feat/spatial-shell-aurora-themes` is already a third presentation of the same data.

The tempting reading is "add a chat mode to app.js." The correct reading is that mast-web has three consumers of one state model and no seam between them. This doc names that seam.

A second question was live when this was written: should native web chat instead be built into [`switchboard`](https://github.com/go-steer/switchboard), the Slack / Google Chat gateway? §7 answers no, and explains why the answer is load-bearing rather than a preference.

## 1. Where we actually are

More of this exists than the framing suggests. Measured against `origin/main` at `5523ae3`:

| Layer | Status |
|---|---|
| **Wire** — `web/attach-core/` (`protocol` · `client` · `replay` · `errors` · `prompter`) | ~936 LOC, conformance-tested against JSONL fixtures. Already extracted, already reusable, no DOM. |
| **State** — `web/state/` (`session` · `connection` · `daemons` · `subscriptions`) | Extracted in [#34](https://github.com/go-steer/mast-web/pull/34). Observable stores, never touch the DOM. |
| **Presentation** — `web/app.js` (3764 LOC) + `web/styles.css` (2084 LOC) | One monolithic shell. This is the layer with no seam. |

And two capabilities that matter more than their PR titles suggest:

**Externally-driven turns** ([#37](https://github.com/go-steer/mast-web/pull/37)). When the SPA is attached to a session someone — or something — *else* is driving, the first `stream-chunk` / `tool-call` auto-creates an observer turn and renders it, rather than dropping it. That is the primitive that makes a *shared* conversation possible: a turn injected from Slack, from a cron companion, or from an autonomous loop paints in every attached browser. **The daemon's session event stream is already the shared substrate.** No new database is required for multi-participant coherence.

**Multi-daemon fan-out** ([#38](https://github.com/go-steer/mast-web/pull/38)). `state/daemons.js` holds a live `AttachClient` per registered backend, connects to all of them in parallel, and aggregates their sessions into one sidebar with peer-tagged provenance. Cross-daemon session switching is instant because nothing disconnects.

Those two together are the hard half of a fleet dashboard, and they already work.

**Capability manifest** (protocol v1.4.0 — `capabilities.features` / `slash_commands` / `agent` / `caller_id`). Per-backend feature negotiation over the wire. This is the mechanism a shell asks "what should I render?" — no `if (backend === 'mast')` branch, per `web-design.md` open question 4.

## 2. What is actually missing

Not much, and it is specific.

**a. There is no shell seam.** `app.js` is state subscription, DOM construction, input handling, slash dispatch, and modal management in one file. A second shell today means either forking it or growing `if (mode === 'chat')` through 3764 lines. Both are worse than the seam.

**b. An observed turn renders the answer without the question.** `addMessage('user', …)` fires in exactly one place — the local `submitPrompt` path (`app.js:2181`). `beginObserverTurn` mirrors the *assistant* render callbacks only. So when another participant drives a turn, we paint the reply and never paint the prompt. For a single-operator console that is invisible. For anything conversational it is the bug that makes the surface unusable.

Worth being precise about *why*, because it changes the fix: the prompt is not missing from the wire. A real backend replays it as a user-authored `agent` frame ahead of the reply — see the committed fixture `attach-core/conformance/fixtures/006-prompt-echo-user-authored.jsonl`. Both shells receive that frame today and deliberately discard it, because for the client that *sent* the prompt, rendering it duplicates the operator's own message inside the agent bubble. So this is a suppression that is too broad, not an absence. §9 used to list a protocol ask for it; it does not need one.

**c. There is no per-turn speaker.** `capabilities.caller_id` is *connection*-level — "who am I" — and feeds the sidebar identity slot (`app.js:304`). `attach-core/protocol.js` does parse an `author` field off each frame, but it carries the ADK agent author, not the human who caused the turn, and `app.js` never reads it. `X-Asserted-Caller` carries the human identity *inbound*; nothing carries it back out. A conversation with unlabeled speakers is not a conversation.

**d. There is no cross-session unread state.** The single highest-value thing a fleet dashboard needs — *which of my forty agents has said something since I last looked?* — has no representation anywhere in the attach protocol, and arguably should not have one.

**e. We are past the framework-decision threshold.** `web-design.md` open question 3 set the trigger at "app.js reaching ~2500–3000 LOC." It is at 3764, and that is *one* shell. Three shells over vanilla DOM with no build step is a decision to make deliberately now, not to discover at shell number two.

## 3. Proposed architecture

```
web/
├── attach-core/       wire     — protocol, client, replay, errors, prompter   (unchanged)
├── state/             model    — session, daemons, connection, subscriptions  (extended)
├── shells/            NEW      — presentation, one directory per shell
│   ├── registry.js             shell registration + selection
│   ├── console/                today's terminal console (extracted from app.js)
│   ├── chat/                   conversational surface (§5)
│   └── fleet/                  multi-daemon dashboard (§6)
└── app.js             host     — boot, daemon wiring, shell mount/unmount
```

The layering rule inherited from the `state/` refactor holds and extends:

- `attach-core/*` — no DOM, no state. Parses the wire.
- `state/*` — no DOM. Reduces typed events into observable stores.
- `shells/*` — **all** DOM. Subscribes to stores; never reaches for `attach-core` directly.
- `app.js` — owns boot, the daemon registry, and which shell is mounted. Shrinks from 3764 lines to a host of a few hundred.

Everything a shell needs already flows through `state/`. That is the whole reason this is an extraction and not a rewrite.

### The shell contract

Deliberately minimal — a shell is a subscriber that owns a DOM subtree.

```js
{
  id:       'chat',
  label:    'Chat',
  mount(root, ctx)   // ctx: { state, daemons, actions, capabilities }
  unmount()          // release subscriptions + DOM; must be idempotent
  capabilities?      // optional: manifest features this shell requires
}
```

Rules that keep this from rotting:

- **Shells never own state.** Anything two shells would both want lives in `state/`. A shell that needs new state adds a store, not a field on itself.
- **Shells are swappable at runtime**, not at build time. Switching shells must not drop the SSE connections — `state/daemons.js` already survives session switches; shell switching is the same discipline.
- **A shell declares its required capabilities** and the registry hides it when the active backend does not advertise them. Same mechanism as feature-gated sidebar sections.
- **Unmount must be clean.** Every `subscribe()` returns an unsubscribe; a shell that leaks one leaks a repaint into the next shell.

Extracting the existing console as the *first* shell is the forcing function. If `shells/console/` cannot be lifted out cleanly, the seam is wrong and we find out before writing a second one.

## 4. Selecting a shell

Three inputs, in precedence order: `?shell=` query param (deep links, smoke specs) → operator selection persisted to `localStorage` under `mast-web:shell` → default (`console`, unchanged behaviour for existing operators).

Deliberately *not* a per-backend server-side default. The shell is an operator preference about how they want to read the same data; it is not the backend's business. Capability gating is the backend's only input.

## 5. The chat shell

**Scope: a conversational surface for driving agents.** Speaker-attributed turns, streaming, collapsible tool calls, session-as-thread, multi-participant.

**Explicitly not** a chat *platform*: no human-to-human DMs, no spaces, no presence, no search, no attachments. §8 draws that line and defends it.

What it needs beyond what exists:

1. **Render observed prompts.** Fix §2b — a `user` row for turns this client did not originate. This is a correctness fix for the observer path and is worth landing on its own, ahead of any shell work, because it improves the console too. No protocol dependency: the frame already arrives (§2b), so the change is narrowing an existing filter from "drop every user-authored frame" to "drop it only when this client originated the turn". The one real chore is presentational — the replayed text is wrapped as `[Inbox]\n- …\n\n---\n\n` and has to be unwrapped before it is renderable as a speaker turn.
2. **Per-turn speaker attribution.** Fix §2c — requires a protocol addition (§9). Until it lands, degrade to a generic "operator" label rather than blocking; the shell must not hard-depend on a field the backend may not send.
3. **Conversation-shaped layout.** Speaker grouping, timestamps, tool calls collapsed by default rather than the console's always-expanded chips.
4. **Thread history on attach.** `attach-core/replay.js` already handles the replay cutoff. Chat makes the cutoff visible ("history begins here") instead of silently starting mid-stream.

Notably *not* needed: a new transport, a new auth path, a new deployment shape, or a backend. The chat shell is a rendering decision over the same stores.

### Prior art

Scion's native web chat (`GoogleCloudPlatform/scion`) is the closest shipped example of this surface and is worth reading for its *design decisions*, not its code — which we are not taking, and whose architecture assumes a hub that owns a message table, which we deliberately do not have. Two conclusions from it transfer directly:

- **One persistence path is an invariant.** Their web spoke implements the event-bus interface but deliberately discards its subscribe handler, because the fan-out hands the same handler to every spoke and a real one would double-persist and double-stream every message. Our analogue: once two clients can drive the same session, exactly one path may create a turn's DOM. `beginObserverTurn` and `submitPrompt` are already two such paths, and they will collide the first time an operator's own turn arrives back over the stream. Worth an explicit invariant now rather than a double-rendering bug later.
- **Feature gates should 404, not hide.** Their chat routes are registered only when the feature is enabled, so disabling it removes the API rather than leaving a live endpoint behind a hidden UI. Our shells are client-side, so the analogue is weaker, but the principle applies to any future server-side shell support.

## 6. The fleet dashboard

The multi-daemon registry gives us N live connections and an aggregated session list. A fleet *dashboard* is a shell over that same registry answering operator questions the sidebar cannot:

- Which agents are running a turn right now, which are idle, which are disconnected?
- Which have said something since I last looked? (**unread** — §2d)
- Which are approaching a cost ceiling or tripped a guardrail? (`GET /sessions/{sid}/guardrails` landed upstream; the data is already reachable.)
- Aggregate spend across the fleet, by daemon and by session.

Unread is the one genuinely new piece of state, and it does not belong in the attach protocol — it is per-*operator*, not per-session. Proposal: **per-client watermarks in `localStorage`**, a last-seen sequence per `(daemon, session)`. Single-device, zero backend, no auth story, no schema. It is wrong the moment an operator uses a second laptop, and that is an acceptable v1 failure mode — promote it to a service when someone actually complains, not before. Building a sync backend for read state is how a dashboard turns into a platform.

## 7. Why here, and not switchboard

Switchboard bridges chat platforms onto the core-agent daemon contract. The clean division is **who owns the platform**:

- **switchboard** adapts platforms we *do not* own. Slack and Google Chat supply identity, persistence, history, search, and the client; switchboard translates them onto the daemon contract and stays a stateless transport. Its `docs/DESIGN.md` §5 non-goals exist to keep it that way.
- **mast-web** is the client for the platform we *do* own — the browser. It already speaks attach directly and does not need switchboard in the loop at all.

Putting a browser chat surface in switchboard would force four things into a deliberately stateless distroless transport: a database (browsers expect history to survive a restart; the conversation→session map is in-memory by design), browser authentication (`X-Asserted-Caller` is *asserted* because Slack already authenticated the human — a browser authenticates nobody), a web asset pipeline, and a multi-platform-per-process restructure (`--platform` is single-valued today).

mast-web already answers all four: attach-mode auth (bearer / mTLS / IAP / Google ID token), four shipped deployment shapes, N-daemon connections, and replay as the history source.

**They compose without either growing a concern it was designed to avoid.** A Slack thread and a browser tab attach to the same daemon session; each renders the other's turns, because #37 already made externally-driven turns render. That is cross-surface coherence with no shared database and no coupling between the two projects.

## 8. The line we are drawing

There are two products behind the words "web chat," and conflating them is the main risk in this doc.

| | **A conversational shell** (this doc) | **A chat platform** (not this doc) |
|---|---|---|
| Participants | Operators + agents | Humans talking to each other, agents present |
| Model | Session = thread | Spaces, DMs, channels, membership |
| State | Attach replay + localStorage watermarks | Message table, read state, search index, attachments |
| Identity | Attach auth + per-turn caller | User accounts, authz, capability model |
| Backend | None new | A real service |

Scion built the right-hand column; it is the majority of what they shipped. **Neither mast-web nor switchboard is that service**, and if we decide we want it, it is a third thing with a database — not a feature of either. Committing to the left-hand column here is the point. The forecast is that we will want exactly one sliver of the right-hand column — fleet unread — and §6 handles that without a backend.

## 9. Protocol asks

One ask. It goes to core-agent / mast, it is additive and forward-compatible, and it is guarded by the capability manifest so shells degrade rather than break against a backend that predates it.

1. **Per-turn caller attribution** — the human identity that drove a turn, carried on the event stream the way `X-Asserted-Caller` carries it inbound. Without it, any multi-participant surface renders unlabeled speakers. This is the blocker for the chat shell's headline feature and the only thing here on the critical path.

An earlier draft listed a second ask — an explicit prompt event, on the theory that the injected prompt text never reaches observers and a turn has to be inferred from its first chunk. That was wrong. The prompt does arrive, as a user-authored `agent` frame ahead of the reply; §2b has the fixture. Nothing upstream is needed for §5.1, which unblocks S0 from the protocol entirely. What the existing frame lacks is the *caller*, which is ask 1 — so the two questions were never really separable.

## 10. Phasing

Each phase is independently useful, and the early ones ship value without committing to the later ones.

| Phase | Scope | Depends on |
|---|---|---|
| **S0 — observed prompts** | Render a `user` row for turns this client did not originate. Correctness fix for the observer path; improves the console today. Narrows an existing filter — no protocol dependency (§9). | — |
| **S1 — shell seam** | `shells/registry.js` + extract today's console to `shells/console/` verbatim. No visible change. The proof the seam is right. | S0 |
| **S2 — framework decision** | Resolve `web-design.md` open question 3 explicitly. Vanilla + build step, or adopt a framework. Do it between S1 and S3, when the cost of being wrong is one shell. | S1 |
| **S3 — chat shell** | `shells/chat/` per §5. Generic speaker labels until the protocol ask lands. | S1, S2 |
| **S4 — fleet dashboard** | `shells/fleet/` per §6, incl. localStorage unread watermarks. | S1, S2 |
| **S5 — spatial shell** | Land `feat/spatial-shell-aurora-themes` as `shells/spatial/`. Cheaper than it looks: its renderer (`web/terminal.js`) is already the console with the singleton assumption removed — per-instance client, turn state and DOM root — which is the same de-singletoning S1 asks of `shells/console/`. Treat it as prior art for the shell contract rather than as a fork to untangle. Also carries the spatial shell's own gaps: permissions, slash commands, modals. | S1 |
| **S6 — attribution** | Consume the protocol ask from §9 once upstream ships it; real speaker names in chat + fleet. | S3, upstream |

S0 is worth doing this week regardless of whether the rest of this doc is accepted.

## Non-goals

- **A chat backend.** No message table, no server-side history, no read-state sync service. §8.
- **Human-to-human messaging.** Agents are participants in every conversation this surface renders.
- **Replacing the console.** It stays the default and stays supported. Shells are additive.
- **Server-selected shells.** Presentation is an operator preference; §4.
- **A plugin API for third-party shells.** In-repo shells only, consistent with `web-design.md`'s existing "no plugin runtime" position. Customization is still a fork.
- **Changing the transport.** SSE + POST over attach, unchanged.

## Open questions

1. **S2's answer.** Bias: a minimal build step (bundle + tree-shake) before a framework — the state layer already does the job a framework's state layer would, so what we are missing is module hygiene, not reactivity. Worth an explicit argument before it is decided by default.
2. **Does the console survive as a shell, or become a chat-shell density mode?** If `shells/chat/` with compact styling is indistinguishable from `shells/console/`, we have two shells maintaining one thing. Defer until S3 is real; do not pre-merge them.
3. **Fleet shell vs. sidebar.** Some of §6 is arguably an expansion of the existing sidebar, not a separate shell. Decide when S4 starts; the seam supports either.
4. **Unread watermark granularity** — per session, or per turn within a session? Per session is cheaper and probably sufficient for "has this agent said anything new."
5. **Do shells compose?** A fleet dashboard with an embedded chat pane for the selected agent is the obvious v2 ask. The contract above assumes exactly one mounted shell. Nesting is a real design change; flagged now so we do not accidentally foreclose it.

## Related

- [`web-design.md`](./web-design.md) — the architecture this extends
- [`v0.3-plan.md`](./v0.3-plan.md) — the `state/` layer and multi-daemon work this builds on
- [attach-mode design](https://github.com/go-steer/core-agent/blob/main/docs/attach-mode-design.md) — the protocol the core consumes
- [SSE wire protocol spec](https://github.com/go-steer/core-tui/blob/main/docs/sse-event-stream-protocol.md) — where §9's asks would land
- [switchboard design](https://github.com/go-steer/switchboard/blob/main/docs/DESIGN.md) — the sibling gateway §7 divides responsibility with
- [ag-ui-design.md](https://github.com/go-steer/mast/blob/main/docs/ag-ui-design.md) — mast's other planned wire; a future `shells/` consumer if an AG-UI core lands beside `attach-core/`
