# attach-core/conformance

Shared SSE-protocol conformance test fixtures for the attach client.

## Purpose

The attach protocol is a spec both `mast-web`'s browser client and
`core-agent`'s Go `coretuiremote` adapter implement independently.
This directory holds JSON fixture pairs — a stream of SSE frames plus
the expected typed-event sequence a spec-compliant client should
produce.

Both consumers run against the same fixtures. Divergence = one
consumer got the protocol wrong; fix immediately.

## Fixture pair

Each fixture is two files:

- `<name>.jsonl` — one SSE frame per line, shaped as
  `{"event": "<event-name>", "data": <payload>}`. `event` is the SSE
  event name (`capabilities`, `status-update`, `usage-update`, `inbox`,
  `turn-complete`, `turn-error`, or `agent`). `data` is the already-
  parsed JSON payload (not a string).
- `<name>.expected.json` — an ordered array of typed events the
  client should have emitted after processing the fixture. Shape is
  `[{"type": "<typed-event>", "data": <observed-data>}, ...]`. Typed
  events include the raw SSE typed events and the sub-events fanned
  out from `agent` frames (`stream-chunk`, `tool-call`, `tool-result`).

## Running

From the repo root:

    npm test

Or targeted:

    npx vitest run web/attach-core/conformance/

## Migration to core-tui

For v0.2.0 these fixtures live in `mast-web/`. The intended long-term
home is `core-tui/docs/conformance/` — spec-adjacent — so both the
`mast-web` and the `coretuiremote` runners point at the same source of
truth. Migration is tracked as a follow-up to
[core-agent#330](https://github.com/go-steer/core-agent/issues/330).
When that lands, the fixture files move under `git mv` and this
directory becomes a small runner that reads from the shared location.

## Adding a fixture

1. Author the frame stream in `<name>.jsonl`. Include the
   `capabilities` frame first (spec §2: every real SSE stream starts
   with one).
2. Author the expected typed-event sequence in `<name>.expected.json`.
   The runner emits typed events in the order they arrive on the
   wire, with `agent` frames fanned out inline.
3. `npm test` — the harness picks up new fixtures automatically.

Design non-goals for v0.2.0 (deferred until we have both consumers
green against the same corpus):
- HTTP-response-side fixtures (permanent-error classification). Today
  covered by unit tests in `errors.test.js` / `client.test.js`.
- Time-series fixtures (idle eviction manifesting as `GET /sessions`
  status flips). Requires the state reducer landing in PR 2.
