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
core-agent --attach-listen :7777 --session-db
```

This starts the agent with the attach HTTP listener bound to `:7777` and durable session storage enabled. You'll see a startup banner including the attach token; copy it for the next step.

## Serve mast-web

```bash
git clone https://github.com/go-steer/mast-web.git
cd mast-web
make dev
```

The static dev server starts on `http://localhost:8000`. Browse there.

## Connect

On first run, mast-web prompts for:

- **Backend endpoint:** `http://localhost:7777`
- **Auth token:** the token from the `core-agent` startup banner

After saving, the chat surface connects and you can submit prompts.

## Where to next

- **[Architecture]({{< relref "/docs/architecture.md" >}})** — what's actually happening under the hood.
- **[Deployment]({{< relref "/docs/deployment.md" >}})** — taking this to a real shared deployment.
- **[Slash commands]({{< relref "/docs/reference/slash-commands.md" >}})** — what `/help`, `/sessions`, etc. do.
