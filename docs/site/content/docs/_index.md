---
title: Documentation
linkTitle: Documentation
weight: 1
menu:
  main:
    weight: 10
---

You're in the `mast-web` reference docs. The site root has the marketing pitch; this section is the reference.

## Start here

**Brand new?** → [Getting started]({{< relref "/docs/getting-started.md" >}}) walks you from `git clone` through `make dev` against your first backend.

**Want to understand the architecture?** → [Architecture]({{< relref "/docs/architecture.md" >}}) explains why mast-web is a thin client (and why it's *not* the cogo-wasm2 pattern).

**Deploying for a team?** → [Deployment]({{< relref "/docs/deployment.md" >}}) covers embedded-into-the-agent-binary vs separately-hosted-Cloud-Run-service patterns, with auth examples (bearer, mTLS, IAP, Google ID token).

**Customizing?** → [Customization]({{< relref "/docs/customization.md" >}}) covers re-skinning the UI, adding slash commands, and integrating with your project's auth/identity.

## Reference

- **[Slash commands]({{< relref "/docs/reference/slash-commands.md" >}})** — `/help`, `/sessions`, `/model`, `/mcp`, `/stats`, `/clear`, and friends.
- **[Attach protocol mapping]({{< relref "/docs/reference/attach-protocol-mapping.md" >}})** — which attach event types drive which UI behaviors. For forks / customization / alternate consumers.

## Status

mast-web is **pre-alpha**. Phase A (UI port from cogo-wasm2) is the first deliverable. See [the bootstrap plan](https://github.com/go-steer/mast-web/blob/main/docs/web-bootstrap.md) for the current phase and the [design doc](https://github.com/go-steer/mast-web/blob/main/docs/web-design.md) for the full architectural rationale.
