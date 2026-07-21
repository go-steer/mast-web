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

## Adding a scenario

One test file per fixture is the current pattern. Add a new file
alongside the existing ones; it'll pick up the shared config
automatically. Test structure:

1. Load `/` with any `?fixture=<name>` param the fixture wants.
2. Complete the setup modal (`/` endpoint, no token).
3. Wait for the fixture to stream through (usually the last frame
   is a `turn-complete` or `turn-error`).
4. Assert on visible DOM state.

Keep assertions focused on what a regression would break — model
name in the sidebar, tool-call chip present, per-turn footer stamped,
etc. Don't assert on things that would legitimately churn (exact
markdown output, class names on stable elements).
