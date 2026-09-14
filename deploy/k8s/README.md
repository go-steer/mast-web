# Kubernetes manifests

Kustomize, no chart. Two layers:

```
base/               the hosted shape: SPA + /attach proxy, human authenticated at the edge
overlays/kind/      base, plus something for it to proxy to
```

Apply the kind overlay with `kubectl apply -k deploy/k8s/overlays/kind`,
or let `dev/tools/kind-cluster` build the image, stand up a cluster,
apply it and assert against it.

## The seam

`base` deploys one workload — the backend-for-frontend — and points it
at a Service named `mast-web-backend`. That name is the whole
configuration surface for "what agent is this cluster talking to".

The kind overlay puts `mast-web-server --mode=mock` behind it. A cluster
with a real agent points the same name at core-agent. Neither the
Deployment, the Service, the probes nor the auth configuration changes
between them, which is the property to preserve when GKE arrives: that
overlay should be an `images:` pin, an `AUTH_MODE=iap-jwt` patch, and
whatever fronts the Service. If it starts rewriting `base`, the split
has stopped paying for itself.

## Authentication

`base` runs `AUTH_MODE=proxy-header`. The browser holds no agent
credential; the agent credential lives in the BFF pod; the human is
authenticated by something in front and named in `X-Auth-Request-Email`,
which the BFF re-asserts to the backend as `X-Asserted-Caller`.

This is sound **only** when the thing in front strips client-supplied
copies of that header and nothing can reach the Service around it. The
Service is `ClusterIP` for that reason. A route that exposes it directly
hands every caller the ability to be anyone — and no unit test can see
that, which is why `dev/tools/kind-cluster` asserts the 401s over a real
network hop instead.

On GKE the replacement is `AUTH_MODE=iap-jwt` plus `IAP_AUDIENCE`: same
shape, but the assertion is a signed JWT, so a client-supplied copy is
not forgeable.

## Probes

`/healthz` and `/readyz` are the only anonymous paths, and both answer
from the same in-process check. Readiness therefore means "this process
is serving", not "the backend is reachable" — a BFF that has lost its
agent still serves the SPA and still returns a truthful error from
`/attach`, which beats removing the endpoint that would explain the
outage.

## What the kind overlay is not

`overlays/kind/mock-backend.yaml` is a fixture replayer. It proves an
identity crosses the pod boundary and that the ACL on the other side
acts on it; it proves nothing about a real agent accepting our requests.
See [#66](https://github.com/go-steer/mast-web/issues/66).
