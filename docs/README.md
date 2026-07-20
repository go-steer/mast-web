# mast-web: docs

Design documentation for `mast-web`. The user-facing documentation site lives under [`site/`](./site/) (Hugo + Docsy); this README and its siblings are the architecture/design surface for contributors.

## Contents

- **[`web-design.md`](./web-design.md)** — the architecture. Why a web UI, why thin-client-over-attach, what we reuse from cogo-wasm2 and what we don't, stack decisions, phase plan. Evergreen.
- **[`web-bootstrap.md`](./web-bootstrap.md)** — the concrete plan for shipping phases A+B+C. Includes the CI conventions, project layout, doc migration plan, and the initial commit sequence. The repo-init portion has executed; phases A, B, C remain. This doc rots once they ship.
- **[`site/`](./site/)** — the Hugo site, deployed to [`go-steer.github.io/mast-web`](https://go-steer.github.io/mast-web/).

## Cross-repo design context

mast-web is a sibling project of [`mast`](https://github.com/go-steer/mast) (docs-only pre-code-fork as of 2026-07-20 — it forks from [core-agent](https://github.com/go-steer/core-agent) per the plan in [fork-design.md](https://github.com/go-steer/mast/blob/main/docs/fork-design.md)). The mast design corpus — positioning, fork mechanics, specialists subsystem, plus 12 further design docs (AG-UI, federation, durable execution, memory, observability, etc.) — lives at `mast/docs/`.

| Doc | Location |
|---|---|
| **mast-web** design (here) | `mast-web/docs/web-design.md` |
| **mast-web** bootstrap (here) | `mast-web/docs/web-bootstrap.md` |
| mast positioning | [`core-agent/docs/mast/positioning.md`](https://github.com/go-steer/mast/blob/main/docs/positioning.md) → eventually `mast/docs/` |
| mast fork mechanics | [`core-agent/docs/mast/fork-design.md`](https://github.com/go-steer/mast/blob/main/docs/fork-design.md) → eventually `mast/docs/` |
| specialists subsystem | [`core-agent/docs/mast/specialists-design.md`](https://github.com/go-steer/mast/blob/main/docs/specialists-design.md) → eventually `mast/docs/` |
| attach protocol | [`core-agent/docs/attach-mode-design.md`](https://github.com/go-steer/core-agent/blob/main/docs/attach-mode-design.md) — what mast-web consumes |

Cross-references in this repo's design docs use absolute GitHub URLs (not relative paths) for any doc outside `mast-web/docs/` so they resolve from any clone or browser.
