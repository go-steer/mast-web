---
title: Getting started
linkTitle: Getting started
weight: 10
description: Run mast-web against a local core-agent (or mast) backend.
---

mast-web is a static web UI. It needs a running backend agent to talk to via the attach protocol. The fastest way to try it is against a local `core-agent --attach-listen`.

## Prerequisites

- Node.js 20+ (for the lint/test tooling)
- Python 3 (for the local dev server)
- A `core-agent` binary built from [github.com/go-steer/core-agent](https://github.com/go-steer/core-agent) — or `mast` once that lands

## Run the backend

```bash
export MAST_ATTACH_TOKEN="$(openssl rand -hex 24)"
core-agent --attach-listen :7777 --session-db --attach-token=MAST_ATTACH_TOKEN
```

This starts the agent with the attach HTTP listener bound to `:7777`, durable session storage enabled, and bearer auth using the token you just generated. Keep it; mast-web asks for it in the next step (`echo $MAST_ATTACH_TOKEN`).

The token isn't optional. Since [core-agent#1266](https://github.com/go-steer/core-agent/pull/1266), a token-less listener on an agent with the `bash` tool **refuses to start** (exit 2). That tool runs as the same user as the agent and could otherwise approve its own permission prompts over the listener. `--attach-token` names an environment variable, which core-agent keeps out of the agent's `bash`. A file the agent can read is no credential, so use `--attach-token-file` only with a pipe or a file the agent's user can't read. Other accepted shapes are mTLS, enforced multi-session auth, or `--attach-readonly`.

## Serve mast-web

```bash
git clone https://github.com/go-steer/mast-web.git
cd mast-web
make dev
```

The static dev server starts on `http://localhost:8000`. Browse there.

## Pick a shell

`/` is a chooser, not a shell. It sends you to **solo** — one terminal at a time, with a
tab strip — unless you say otherwise. **Spatial** puts several terminals in a 3D room.
Both are the same terminal in different furniture; nothing is only in one of them.

- `?shell=spatial` on the URL for a one-off. A deep link does not change your default —
  sending someone a link should not re-home them.
- The `room ↗` / `solo ↗` link in the HUD strip switches, and that one sticks.
- `/shell` from the prompt lists both and records a choice.

## Connect

Add the backend from the sidebar's attach form, or type `/attach http://localhost:7777`:

- **Backend endpoint:** `http://localhost:7777`
- **Auth token:** the token from the `core-agent` startup banner

The daemon appears as a sidebar row with its sessions under it; click one to open a
terminal and submit prompts. Behind
`mast-web-server --mode=proxy` there is no step here at all — the endpoint is discovered
at boot.

## Where to next

- **[Architecture]({{< relref "/docs/architecture.md" >}})** — what's actually happening under the hood.
- **[Deployment]({{< relref "/docs/deployment.md" >}})** — taking this to a real shared deployment.
- **[Slash commands]({{< relref "/docs/reference/slash-commands.md" >}})** — what `/help`, `/sessions`, etc. do.
