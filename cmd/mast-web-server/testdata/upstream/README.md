# Upstream conformance captures

Copied verbatim from `go-steer/core-agent` at `04fcaa5` (2026-10-09),
`pkg/attach/testdata/conformance/`. These are the producer's own record
of what it sends. Don't edit them; replace them from upstream when it
changes.

They're the reference `TestUpstream_*` in `mock_upstream_test.go` holds
the mock against, in two directions:

- the conformance fixtures under `web/attach-core/conformance/fixtures/`
  that claim to carry one of these frames must carry it **verbatim**, and
- what the mock's own handlers put on the wire (a guardrail trip, a cut
  turn's `canceled`, a downgraded `/perms/respond`) must have **the same
  keys** as the capture.

That's the discipline `TestMock_SessionRowsUseCanonicalWireShape` set
in v0.4: a mock that invents a shape the real wire doesn't have is how
#41 shipped. It's also how the v0.5 walkthrough found the mock unable
to run a turn at all. Nothing compared it to the producer.

| File | Protocol | What it is |
|---|---|---|
| `guardrail-trip-cut-v1.19.0.json` | 1.19.0 | a per-turn cost trip that cut its turn, with `event_id` |
| `guardrail-trip-boundary-v1.13.0.json` | 1.13.0 | a watchdog trip at a turn boundary, before `event_id` existed |
| `turn-error-v1.19.0.json` | 1.19.0 | the `canceled` that follows a cut, with `event_id` |
| `rest-perms-respond-v2.json` | 1.17.0+ | a `/perms/respond` 200 that was downgraded |
