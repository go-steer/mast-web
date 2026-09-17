feat: session sharing from the terminal (#91)

Protocol 1.10.0 gave the ACL a write verb (core-agent#797): GET and
PATCH on /sessions/{sid}/acl, returning {owner, viewers, contributors}.
Until now the browser could read a roster the server had already
filtered per caller, and that was all — sharing a session meant leaving
the browser. 019's whole premise (two operators, one daemon) could be
asserted only against a fixture somebody else had seeded.

So: /share, in the palette.

Why a command and not a sidebar dialog. The plan left this open (OQ 1)
and the answer turned out not to be taste. The ACL routes are
session-scoped, but state/daemons.js holds one AttachClient per
*daemon*, so a sidebar row has no bound session to ask about. And
X-Attach-Protocol-Version is stamped only on /events
(pkg/attach/protocol.go:95, whose sole caller is handlers.go:478), so a
row for a session nobody has opened has never seen a version. Neither
gap can be papered over by probing, because denial on these routes is
404 rather than 403 — a probe cannot tell "your backend is too old"
from "this session is not yours". A panel knows both facts, so the
panel is where the gesture lives.

That also settles the ownership message for free. With the version
already known, a 404 has exactly one meaning left, and /share says the
one it has rather than the generic error.

The PATCH discipline. Fields are *[]string: absent means leave alone,
[] means clear. We send only the lists that actually changed, so an
untouched list is never round-tripped from a snapshot that may already
be stale — the lost-update window on an authorization decision is
narrow enough as it is. Grants are exclusive: promoting a viewer to
contributor removes them from viewers, because both lists satisfy Read
upstream and an identity in both would display two things about one
permission. The rendered list is the server's echo, never the request
we sent; a unit test's stub normalizes the write away to prove it.

The version gate, which is new machinery. available() asked one
question (hasFeature) and now asks two. They fail opposite ways, and
that is the point: an absent flag means ON, because a producer that
predates the flag still has the feature (§2.1, additive); an absent or
older version means OFF, because a producer that predates the route
does not have the route. /share is gated on 1.10.0 and no flag mentions
it, so the version is the only thing that can hide it.

Which caught a bug in #70 as it went past: /pause, /continue and
/abandon were gated on features.pause alone, and an absent pause flag
reads as on — so a pre-1.5.0 backend, which has no /pause route at all,
was being offered all three. They now carry minVersion: '1.5.0' too.
Both gates apply where a row has both, and they catch different
backends: the flag catches one built without a PauseController, the
version catches one built before the route existed.

Tests. 13 unit cases over /share (both counts and the (none) branch,
(you) marking, a grant sending only the touched list, a promotion
sending both, the echo-not-the-request rule, revoke, the two no-op
cases that must not PATCH at all, the owner refused, usage on a missing
or unknown argument with no GET fired, 404 -> "not yours", other errors
verbatim, and hidden-and-refused at 1.7.0 with the client untouched),
plus one on the hold's new version gate. 59 in terminal.test.js, 437
across the suite.

Three smoke cases in 019, which is the file that could not make this
claim before: smoke@ grants repo-indexer to bob and bob's roster grows
from two rows to three with the new one marked shared and undeletable;
a revoke on the seeded ops-triage grant takes it back out; and bob,
who can read ops-triage, cannot read its ACL and is not told who else
is on it. A beforeEach resets the mock's share state, because an ACL
leaking into the next spec would hand somebody a session they are
meant to be unable to see, which is the one thing this file exists to
catch.

016's footer assertion grows to five gated names. Fixture 005
negotiates 1.4.0, which makes it the version gate's case as well as
the feature flag's.

Closes #91.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
