# smoke/

Automated end-to-end smoke tests. Playwright drives headless Chromium
against the standalone mock backend (`mast-web-server --mode=mock`);
each test connects the SPA to the mock and asserts on the rendered
DOM per conformance fixture.

## Run

Locally:

```bash
npm run smoke:headless    # boots mock + runs Playwright suite
```

Or drive Playwright directly if you want its trace viewer:

```bash
npx playwright test
npx playwright show-report
```

`playwright.config.js` autostarts the mock via `webServer:` — no
manual setup needed. Set `SMOKE_PORT` to override the default `:7799`.

## CI

The `.github/workflows/smoke.yml` workflow runs these on every PR +
main push. Playwright's browser download is cached between runs.
Failures upload a trace + screenshot artifact for triage.

## Which shell

There are two: `solo.html` (one terminal, the default) and
`spatial.html` (a room of them). `/` is neither — it is a redirector
that picks one (`018-shell-entry`). Both mount the same `terminal.js`,
so a renderer assertion belongs in one shell, not both; use the second
only when the shell itself is part of the claim (tabs, the room's
camera, an overlay's position).

`openSoloSession(page, fixture)` and `openSpatialSession(page, fixture)`
in `helpers.js` clear storage, load the shell, click the mock's first
session row and hand back that terminal's `.term-screen`.

## Adding a scenario

One test file per fixture is the current pattern. Add a new file
alongside the existing ones; it'll pick up the shared config
automatically. Test structure:

1. `const screen = await openSoloSession(page, '<fixture>')`.
2. Wait for the fixture to stream through (usually the last frame
   is a `turn-complete` or `turn-error`).
3. Assert on visible DOM state, scoped to `screen`.

Keep assertions focused on what a regression would break — the model
in the terminal's status row, tool-call chip present, per-turn footer
stamped, etc. Don't assert on things that would legitimately churn
(exact markdown output, class names on stable elements).
