---
title: mast-web
---

{{< blocks/cover title="mast-web" image_anchor="top" height="full" >}}
<p class="lead mt-5">Operator-facing web UI for <code>mast</code> and any attach-mode-compatible <code>core-agent</code> variant.</p>
<a class="btn btn-lg btn-primary me-3 mb-4" href="/mast-web/docs/">
  Read the docs <i class="fa-solid fa-arrow-right ms-2"></i>
</a>
<a class="btn btn-lg btn-secondary me-3 mb-4" href="https://github.com/go-steer/mast-web">
  GitHub <i class="fa-brands fa-github ms-2"></i>
</a>
{{< /blocks/cover >}}

{{% blocks/lead color="dark" %}}
Thin client over the attach protocol. The agent loop lives on the backend (where MCP servers, K8s context, credentials, audit log, and cost ceilings live); the browser renders the chat surface, tool calls, plan-first plans, watchdog alerts, and cost telemetry.

No agent code in the browser. No installation on the operator's machine — just a URL.
{{% /blocks/lead %}}

{{% blocks/section color="primary" type="row" %}}

{{% blocks/feature icon="fa-solid fa-cloud" title="Cloud-native by design" %}}
Connects to a backend agent running in a Cloud Run pod, Kubernetes service, or daemon container. Auth via the attach mode's existing paths — bearer token, mTLS, Google ID token, IAP.
{{% /blocks/feature %}}

{{% blocks/feature icon="fa-solid fa-users" title="Multi-operator" %}}
Two SREs viewing the same incident-triage session at once is natural. Sessions persist on the backend; the browser is a window into them.
{{% /blocks/feature %}}

{{% blocks/feature icon="fa-solid fa-mobile-screen" title="Mobile-viable" %}}
At-a-glance status checks from a phone work. Full operator workflows are desktop-shaped, but the responsive UI doesn't fall apart on small screens.
{{% /blocks/feature %}}

{{% /blocks/section %}}
