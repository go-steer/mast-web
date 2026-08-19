---
title: Deployment
linkTitle: Deployment
weight: 30
description: Deployment shapes for mast-web, and how to authenticate real users in a hosted, multi-user install.
---

mast-web ships as a static SPA plus a small Go server (`mast-web-server`) that serves it.
Which of the two you deploy — and whether the server also proxies the attach API — is the
only real decision.

## Pick a shape

| Shape | Command | Auth boundary |
|---|---|---|
| **Local dev** | `make dev`, connect to `http://localhost:7777` | none; loopback only |
| **Mock** | `mast-web-server --mode=mock` | none; no backend, no credentials |
| **Single-operator proxy** | `mast-web-server --backend-url=... --backend-token=...` | your network |
| **Hosted, multi-user** | proxy mode + `--auth-mode` | **mast-web-server** (see below) |

### Cross-origin is not a supported shape

`--mode=static` points the SPA at a backend URL you type into the setup modal. Against the
bundled mock that works. Against a real `core-agent` / `mast` backend it **cannot** work:
neither backend emits any `Access-Control-Allow-*` header, and neither has an `OPTIONS`
handler, so the browser blocks every response — including `GET /sessions`. Use a loopback
backend, or serve the SPA same-origin behind `--mode=proxy`.

Related: the attach protocol has no `?access_token=` query parameter. A token can only
travel in `X-Attach-Token` or `Authorization`, and `EventSource` cannot set headers — which
is the other reason a hosted install has to terminate auth at the proxy.

---

## Hosted, multi-user: the BFF model

In proxy mode `mast-web-server` can act as a backend-for-frontend. It authenticates the
human at its own edge, then forwards that identity to the agent:

```
browser ──IAP assertion / trusted header──▶ mast-web-server ──service cred──▶ agent
  holds no agent credential                  scrubs client headers            X-Asserted-Caller: alice@example.com
                                                                              (the agent's per-caller ACLs apply)
```

Two independent knobs:

- **`--auth-mode`** — how *this* server identifies the human.
- **`--backend-auth`** — how *this* server authenticates itself to the agent.

They are unrelated: you can run `--auth-mode=iap-jwt --backend-auth=google-id-token`, or
`--auth-mode=proxy-header --backend-auth=bearer`, or any other pairing.

### `--auth-mode`

| Value | Identity source | Use when |
|---|---|---|
| `none` *(default)* | — | Loopback dev, mock, single-operator installs |
| `proxy-header` | `--auth-header` on each request | An authenticating proxy already fronts you |
| `iap-jwt` | `X-Goog-IAP-JWT-Assertion` | Google Cloud IAP (GKE, Cloud Run, GCLB) |
| `oidc` | — | Reserved; not implemented yet |

Anything other than `none` requires `--mode=proxy` — authenticating the human is
meaningless when this server doesn't carry the traffic. The server errors rather than
silently downgrading.

#### `iap-jwt` (recommended on Google Cloud)

```bash
mast-web-server \
  --backend-url=http://core-agent.default.svc:7777 \
  --auth-mode=iap-jwt \
  --iap-audience=/projects/123456789/global/backendServices/987654321 \
  --backend-auth=google-id-token \
  --external-url=https://mast.example.com
```

The assertion is verified against Google's published keys: signature, exact `aud`, `exp`,
and `iss == https://cloud.google.com/iap`. `alg: none` and HMAC algorithms are rejected.
The caller is the assertion's `email` claim, falling back to `sub`.

Find the audience with:

```bash
gcloud compute backend-services describe <name> --global --format='value(id)'
# audience = /projects/<PROJECT_NUMBER>/global/backendServices/<ID>
```

Make sure the pod is **only** reachable through the load balancer. IAP protects the LB, not
your service — a request that reaches the pod directly carries no assertion and is refused,
but a request that reaches it directly *with a forged assertion header* is refused only
because the signature check fails. That check is the actual protection; keep it enabled and
keep the audience exact.

#### `proxy-header`

```bash
mast-web-server \
  --backend-url=http://core-agent.default.svc:7777 \
  --auth-mode=proxy-header \
  --auth-header=X-Forwarded-Email
```

There is deliberately **no default header name** — a default would be a well-known string
for an attacker to send. This mode is only sound if both hold:

1. The fronting proxy **strips any client-supplied copy** of the header before setting its
   own. Most don't by default.
2. The mast-web-server port is not reachable except through that proxy.

Neither is enforceable from inside this process, so the server logs a warning at startup
naming the header it trusts. If you can use `iap-jwt`, prefer it — a signature is checkable;
a header is not.

### `--backend-auth`

| Value | What it sends |
|---|---|
| `bearer` *(default)* | `--backend-token` as `Authorization: Bearer` + `X-Attach-Token` |
| `google-oauth` | An OAuth2 access token from Application Default Credentials |
| `google-id-token` | An audience-bound ID token from ADC (`--backend-audience`, defaults to `--backend-url`) |

Google modes put their token on `Authorization` and keep `--backend-token`, if set, on
`X-Attach-Token` — the same split `core-agent-tui` uses, so one mental model covers both.
Credential resolution failures return **502**, never a silent 401.

### What the proxy scrubs

Every proxied request has these deleted before it leaves:

- **`X-Asserted-Caller`** — always, in every mode. A client-supplied value would otherwise
  reach the agent's caller middleware and impersonate anyone. This is why enabling proxy
  mode and enabling the scrub had to be the same change.
- **`Origin` and `Referer`** — the agent's write guard passes requests with no `Origin`
  (that's what a native client looks like), and rejects an `Origin` that isn't its own. Once
  the BFF enforces the equivalent check inbound, the BFF *is* a native client.
- **`Authorization`, `X-Attach-Token`, `Cookie`** — only when `--auth-mode != none`. In
  `none` mode the client's own token still flows through untouched, which is what keeps
  today's single-operator setup working byte-for-byte.

Inbound, when auth is on, writes must carry `Content-Type: application/json` (else 415) and
a present `Origin` must match `--external-url` or the request host (else 403).

### Other hosted flags

| Flag | Env | Default | Purpose |
|---|---|---|---|
| `--external-url` | `EXTERNAL_URL` | — | Canonical public origin; used by the CSRF check |
| `--sse-max-lifetime` | `SSE_MAX_LIFETIME` | `30m` | Cap on any proxied request, SSE included |
| `--allow-unauthenticated` | `ALLOW_UNAUTHENTICATED` | `false` | Acknowledge an open, non-loopback proxy |

`--sse-max-lifetime` exists because auth is checked at connect. Without a cap, a stream
opened just before a session expires outlives it indefinitely. The browser's built-in
`EventSource` reconnect re-authenticates naturally, so the cap is invisible in normal use.

Running proxy mode on a non-loopback address with `--auth-mode=none` means anyone who can
reach the port gets full credentialed access to the agent as a single shared identity. That
prints a loud startup warning; `--allow-unauthenticated` acknowledges it. A future minor
will make it a hard refusal.

### `GET /config`

Served in every mode, exempt from auth (an unauthenticated SPA still has to be able to
discover that it is unauthenticated), and `no-store`:

```json
{
  "mode": "proxy",
  "api_prefix": "/attach",
  "multi_daemon": false,
  "backends": [],
  "auth": { "mode": "iap-jwt", "authenticated": true, "identity": "alice@example.com" }
}
```

`multi_daemon` / `backends` are reserved for a later backend-alias map; they are always
`false` / `[]` today.

---

## Backend configuration

The agent has to be told to trust the assertions mast-web-server sends. On `core-agent`,
with multi-session enabled:

```yaml
multi_session:
  proxy_identities: ["sa:mast-web"]
```

and a `users.json` row for the BFF's own identity:

```json
{"version": 1, "users": [{"identity": "sa:mast-web", "token": "<BACKEND_TOKEN>"}]}
```

That row is required, not optional: the request first authenticates as the BFF's own
identity, and only then is the asserted caller applied. Without it the request 401s before
the asserted path runs.

The asserted callers themselves must currently also exist in the user table, and each row
requires a unique non-empty token — so pre-provisioning N users mints N live bearer
credentials that authenticate directly and bypass the BFF. Until the agent grows a
just-in-time asserted-caller option, keep the roster small and the tokens random.

Verify the whole chain with `GET /whoami` through the proxy: it should report
`source: "asserted"` with `proxy_by` set to the BFF identity.

## Testing it

`dev/tools/e2e-real-backend` stands the whole thing up against a real agent — daemon,
BFF, two identities — and asserts what the unit tests structurally can't: that the real
`browserWriteGuard` accepts our proxied writes, that a client-supplied `X-Asserted-Caller`
is really dropped before the real caller middleware sees it, and that both SSE streams
connect against a token-protected backend.

```bash
git clone https://github.com/go-steer/core-agent && cd core-agent
go build -o /tmp/core-agent ./cmd/core-agent

cd ../mast-web
CORE_AGENT_BIN=/tmp/core-agent make e2e
```

The rig's agent runs `model.provider: echo` by default, which needs no credential — every
assertion is about auth plumbing and none of them care what the model says. The echo
provider replays the prompt verbatim, so a "reply" that looks like your own question is
correct. Point it at a real model when you want the rig to answer:

```bash
gcloud auth application-default login
MODEL_PROVIDER=vertex MODEL_NAME=gemini-3.7-flash \
  GOOGLE_CLOUD_PROJECT=my-project GOOGLE_CLOUD_LOCATION=global \
  CORE_AGENT_BIN=/tmp/core-agent KEEP_RUNNING=1 make e2e
```

Add `KEEP_RUNNING=1` to leave a browsable rig up. It starts one header-injecting proxy per
identity — the local stand-in for IAP — on consecutive ports. Different ports are different
origins, so two ordinary tabs get separate `localStorage` and behave as two different users
against one agent. In the setup modal use `/attach` as the endpoint and leave the token
blank.

Two things the rig gets right that a hand-rolled one usually doesn't. It uses a
**non-loopback** external URL (`https://mast.example.com`): core-agent's `originAllowed`
waves through any loopback `Origin`, so a rig hosted on `127.0.0.1` passes the CSRF tests
whether or not the proxy strips `Origin`. And the injecting proxies `Del` the header before
they `Set` it, which is the requirement `proxy-header` mode can't verify for itself.

## Kubernetes

Nothing exotic — the server is stateless in every mode this page describes.

```yaml
env:
  - name: BACKEND_URL
    value: http://core-agent.default.svc:7777
  - name: AUTH_MODE
    value: iap-jwt
  - name: IAP_AUDIENCE
    valueFrom: { secretKeyRef: { name: mast-web, key: iap-audience } }
  - name: BACKEND_AUTH
    value: google-id-token
readinessProbe: { httpGet: { path: /readyz, port: 8080 } }
livenessProbe:  { httpGet: { path: /healthz, port: 8080 } }
```

Both probes are exempt from auth. Set your ingress read timeout above
`--sse-max-lifetime`, or the ingress will cut streams before the server does.
