# mast-web: manual walkthrough

**Status:** living. Re-run before every tag; update whenever a section stops matching what the screen does.

Everything else this repo verifies is verified by a machine. `dev/tools/ci` proves the units agree with each other and the Playwright suite proves the DOM does what the last person to touch it expected. **Neither of them looks at the screen.** This document is the part a person does: sit down, follow the list, and come away with a yes or a no on each capability.

It is written to be *run*, not read. Every section is **Setup → Steps → Expected → Why this matters**, and names the issue it verifies. "Expected" is deliberately specific — the failure this catches is the near-miss, the banner that is technically present and visually wrong, and you cannot notice a near-miss against a description that would also fit one.

Audience: someone who knows what mast-web is and wants to know whether this build is sound. Not a tutorial.

Sections 4 through 9 cover the v0.5.0 surface. What each of those changed, in prose, is [`CHANGELOG.md`](../CHANGELOG.md#050---2026-09-17); why it changed is [`v0.5-plan.md`](./v0.5-plan.md).

## Before you start

```
dev/tools/mock-backend           # SPA + fake attach backend, same origin, :7778
```

Then open <http://localhost:7778/>.

`npm run dev` is the *other* server — `--mode=static`, no backend at all, for pointing the SPA at a live daemon. Every section here uses the mock, because the mock is the only backend that can be put into the states this document is about (nobody verified, a subagent that already finished, two identities) on demand.

The mock speaks **protocol 1.12.0** by default and replays `001-happy-turn`. Three of its four sessions are pinned to older fixtures on purpose — see [§10](#10-known-not-to-work).

**The two operators.** The mock reads a `mock_caller` cookie (`cmd/mast-web-server/mock_acl.go`) and answers `/sessions`, `/whoami` and the ACL routes accordingly. With no cookie you are `smoke@example.com`. To become the other one, open DevTools and run:

```js
document.cookie = 'mock_caller=bob@example.com; path=/';
location.reload();
```

and to go back:

```js
document.cookie = 'mock_caller=smoke@example.com; path=/';
location.reload();
```

The cookie is the carrier rather than a header because the SPA's stream is an `EventSource`, and `EventSource` cannot set a header at all.

The roster the two of them share:

| session | owner | shared with | fixture |
|---|---|---|---|
| `smoke-session` | smoke@ | — | server default (1.12.0) |
| `ops-triage` | smoke@ | bob@ (viewer) | `003-tool-result-with-latency` |
| `repo-indexer` | smoke@ | — | `002-cost-ceiling-mid-turn` |
| `docs-writer` | bob@ | smoke@ (viewer) | `004-observer-mode-usage-update-only` |

So each operator sees one session they own and one somebody shared — neither branch can go unexercised — and each has sessions the other must never see.

**Resetting.** Three pieces of mock state survive a reload and will leak between sections if you let them:

```
curl -X DELETE localhost:7778/_mock/pause-gates      # holds
curl -X DELETE localhost:7778/_mock/perms-log        # approval log
curl -X DELETE localhost:7778/_mock/turn-requests    # inject/wake tally
```

Clearing your browser's `localStorage` for the origin resets the shell preference, tab layout and saved daemons.

---

## 1. A turn, start to finish

**Verifies:** the baseline. If this is wrong nothing below is worth checking.

**Setup:** mock on :7778, fresh `localStorage`.

**Steps**

1. Open <http://localhost:7778/>.
2. Click the `smoke-session` row in the left sidebar.
3. Type `what is the weather` into the composer and press Enter.
4. Wait for the turn to finish.

**Expected**

- The sidebar lists four sessions. Two of them (`ops-triage`, `docs-writer`) arrive already titled, so those rows lead with the title and carry the session id on a second line; the other two lead with the id. The panel header shows the session and the connection goes to **connected** — not "connecting" that never resolves.
- Your prompt appears as your own message, once. (Twice is core-agent#639; the mock counts posts so `curl localhost:7778/_mock/turn-requests` should show a single `inject`.)
- Assistant text streams in progressively rather than appearing in one block at the end.
- A **STOP** button appears next to the composer while the turn runs and disappears when it ends.
- A turn footer lands at the bottom with token counts and a cost. The cost is a number, not `$undefined` or `$0.00` where a number was streamed.
- The status bar at the bottom of the window shows the model and the daemon.

**Why this matters:** every other section assumes streaming, one-turn-per-prompt and a live footer. A failure here is not a feature bug, it is the client.

---

## 2. The chooser and the entry paths

**Verifies:** v0.4 plan §1 (`web/shell-select.js`).

**Setup:** fresh `localStorage` (DevTools → Application → Clear site data).

**Steps**

1. Open `/`. Note which shell you land in.
2. Open `/?shell=spatial`. Note where you land.
3. Go back to `/` with no query.
4. In the spatial shell, use the HUD's shell link to switch to solo.
5. Open `/` again.
6. Disable JavaScript and open `/`.

**Expected**

| step | expected |
|---|---|
| 1 | **solo** — the default is the surface that works on a trackpad. |
| 2 | **spatial**. |
| 3 | **solo** again. A `?shell=` deep link must *not* have become your stored preference — sending someone a link to the room should not re-home them there. |
| 4 | solo, and the choice is stored (`localStorage['mast-web:shell']`). |
| 5 | **solo**, from the stored preference this time rather than the default. |
| 6 | A plain page naming both shells with working links — not a blank page, not a 403, not a directory listing. |

**Why this matters:** `/` is the front door and a static host has no server to rewrite with. The precedence rule is the only thing standing between "remember where I work" and "retype the query string every morning".

---

## 3. Both shells

**Verifies:** that a control exists in both places. A feature that only landed in one shell is the single most common way this repo has shipped something half-done.

**Setup:** mock on :7778.

**Steps**

1. Open `/?shell=solo`, open `smoke-session`, run `/help`.
2. Open `/?shell=spatial`, open `smoke-session` into a panel, run `/help` there.
3. In each, run one turn and press **STOP** mid-turn.
4. In each, run `/pause`, then `/continue`.
5. In each, check the sidebar for the rename (`✎`) and delete (`×`) controls on `smoke-session`.

**Expected**

- Both `/help` outputs list the same built-ins: `/help`, `/clear`, `/export`, `/tools`, `/mcp`, `/subagents`, `/perms`, `/specialists`, `/sessions`, `/guardrails`, `/pause`, `/continue`, `/abandon`, `/share`, `/model`, `/usage`, `/whoami`. Neither shows *"Not supported by this backend"* against the default fixture.
- STOP, the hold banner and the sidebar controls behave identically in both. The spatial shell draws them inside a panel; the affordances are the same.
- The spatial shell's panel is orbit-able and the terminal inside it still takes keyboard input after you have moved the camera.

**Why this matters:** the shells share a core precisely so this comparison is boring. The moment it stops being boring, the sharing has broken.

---

## 4. Stop

**Verifies:** #68 / #73.

**Setup:** mock on :7778; `curl -X DELETE localhost:7778/_mock/pause-gates` first.

**Steps**

1. Open `smoke-session` in solo.
2. Start a turn.
3. Press **STOP** while text is still streaming.
4. Immediately type another prompt and send it.

**Expected**

- The turn stops. The composer comes back and the STOP button disappears.
- **No hold banner appears.** Stop cancels; it does not park.
- The follow-up prompt starts a new turn straight away — no gate to release first.

**Why this matters:** the wire distinction between a cancel and a park (`X-Interrupted`) is invisible in the UI, and that is correct — what an operator sees is the turn ending and the composer coming back. What would be wrong is Stop leaving the session in a state that needs a second gesture to escape.

---

## 5. The hold

**Verifies:** #70, and protocol v1.11.0's change (core-agent#878) that an inject no longer releases a hold.

**Setup:** mock on :7778; clear pause gates first and again afterwards — a held session leaks into the next section.

**Steps**

1. Open `smoke-session` in solo.
2. Run `/pause looking at the diff`.
3. Read the banner.
4. Type `actually use the other branch` — a plain message, not a command — and press Enter.
5. Run `/tools`.
6. Press **CONTINUE**.
7. `/pause` again, then press **ABANDON**.

**Expected**

- After step 2 the banner reads **`HELD — looking at the diff`**, with a detail line saying what was in flight and when — *"Nothing was in flight. No new turn starts until this is released. Held since 14:22:07."* — a **CONTINUE** and an **ABANDON** button, and a hint *"…or type a correction to steer"*. The composer stays **enabled**, and its placeholder changes to `type a correction to steer, or /continue…`.
- Step 4: the session **stays held**. The message is a steer — it goes to `/resume`, not to `/inject`. Check with `curl localhost:7778/_mock/turn-requests`: there must be **no** new `inject`. This is the 1.11.0 assertion in the form a person can perform, and the failure mode it catches is the bad one: an inject queues behind the gate forever and the session looks like it swallowed your message.
- Step 5: a slash command at a held session is still a command — `/tools` renders its catalog and the hold is unaffected.
- Step 6: the banner disappears, and a system line says **`Session resumed (continue)`**.
- Step 7: ABANDON is the same gesture as `/abandon` — banner gone, and the disposition named in the transcript.

**Why this matters:** "stop and let me look" is worth nothing if the only way out of the gate is to close the browser, which is what v0.4 shipped. And a hold whose composer is disabled cannot be steered, which is most of the point of holding.

---

## 6. Status truth

**Verifies:** #93 (protocol v1.12.0, core-agent#896).

**Setup:** mock on :7778; pause gates cleared. Two things to have open: the solo shell, and a terminal for `curl`.

Every turn in this section is started from **outside** the browser on purpose. A turn this page dispatched is already visible in its own elapsed timer, and it was never the one being got wrong.

**Steps**

1. With no browser tab open yet, start a turn from outside:
   ```
   curl -X POST localhost:7778/sessions/smoke-session/inject \
        -H 'Content-Type: application/json' \
        -d '{"message":"draft the release notes","wake":true}'
   ```
2. Now open the solo shell and click `smoke-session`.
3. With the tab still open, clear the gate: `curl -X DELETE localhost:7778/_mock/pause-gates`.
4. Start another outside turn (step 1 again) while watching the already-open tab.
5. While that turn is running, interrupt from outside:
   ```
   curl -X POST localhost:7778/sessions/smoke-session/interrupt \
        -H 'Content-Type: application/json' \
        -d '{"hold":true}'
   ```
   `hold:true` is the *other* gesture — cancel the turn **and** park the loop. The browser's STOP sends `hold:false`, which is why §4 sees no banner and this step does.

**Expected**

- Step 2: the panel opens showing **`⟳ turn in flight`**, and the window's status bar reads **`1 running`**. It must *not* open looking idle. No frame says this — the panel asks `GET /status` once on connect, because a turn that started a minute before you opened the tab announced itself to whoever was listening then.
- Step 3: the in-flight marker clears within a few seconds.
- Step 4: the marker appears **without a reload**, within about ten seconds — that is the idle poll cadence, and the point of the step is that a second read happens at all.
- Step 5: the hold banner appears **and** the in-flight marker stays up, with the detail line reading *"The turn it interrupted is still unwinding."* The status bar shows **both** `1 running` and `1 held`.

**Why this matters:** `state` has one slot and pause outranks running in it, so a session parked mid-turn reports `paused` and the bool beside it is the only thing that can say the turn is still going. A held session with nothing running is a session waiting for you; a held session with a turn behind the gate is still spending money. Collapsing those two is the bug the whole section exists for.

---

## 7. Sharing

**Verifies:** #91 (protocol v1.10.0, core-agent#797).

**Setup:** mock on :7778. This section switches identity twice; keep the DevTools console open.

**Steps**

1. As **smoke@** (no cookie, or the cookie set to `smoke@example.com`), open `/?shell=solo&fixture=001-happy-turn` and click `repo-indexer`. The fixture query matters: `repo-indexer` is otherwise pinned to a 1.4.0 capture and `/share` is correctly refused against it. (See [§10](#10-known-not-to-work) — and try it without the query once, on purpose.)
2. Run `/share`.
3. Run `/share viewer bob@example.com`.
4. Switch to **bob@** and reload.
5. Look for `repo-indexer` in bob's sidebar. Open it.
6. As bob, run `/share`.
7. Switch back to **smoke@**, reopen `/?shell=solo&fixture=001-happy-turn` → `repo-indexer`, and run `/share revoke bob@example.com`.
8. Switch to bob@ and reload.

**Expected**

- Step 2: the current ACL — owner `smoke@example.com`, and empty viewer/contributor lists.
- Step 3: the grant is echoed back from what was **stored**, not from what you typed.
- Step 5: `repo-indexer` is now in bob's sidebar, marked as shared — a short form of the owner's identity on the row, and a tooltip reading *"shared with you by smoke@example.com"*. It opens and streams.
- Step 5, the negative half: on that row bob gets **no delete control (`×`) and no rename control (`✎`)**. Reading a session is not permission to destroy or re-label it.
- Step 6: bob is **refused**. A guest is not told who else is on the session.
- Step 8: `repo-indexer` is gone from bob's sidebar.
- Throughout: bob never sees `smoke-session` and smoke@ never sees anything of bob's beyond `docs-writer`, which bob shared.

Also worth a look while you are switched: the HUD names who you are, and the new-session button names the owner it will stamp — sharing is worthless if you cannot tell which identity you are acting as.

**Why this matters:** every failure mode here is social rather than mechanical. "Whose session is this?" is not a question a selector assertion can ask, and a sidebar that shows one operator another operator's roster is the kind of bug that looks fine in every screenshot.

---

## 8. Rename

**Verifies:** #92.

**Setup:** mock on :7778.

**Steps**

`repo-indexer` is the one untitled session smoke@ owns, which is why it is the target: the change is visible.

1. As smoke@, hover the `repo-indexer` row and click the `✎` control.
2. Type `tuesday incident` and accept.
3. Look at the row, and at the solo tab strip if the session is open.
4. Click `✎` again, type `  spaced out  ` with leading and trailing spaces, and accept.
5. Click `✎` again, empty the box, and accept.
6. Click `✎` a fourth time, type something, and **cancel**.
7. Switch to bob@ and find `ops-triage`, which smoke@ owns and bob can see.

**Expected**

- Step 3: the row's primary line now reads **`tuesday incident`** and the session id **moves to the meta line underneath** rather than disappearing — the id is what correlates a row with a URL or a log.
- Step 4: the row shows what the server **stored**, not what you typed — `spaced out`, trimmed.
- Step 5: the name clears and the row falls back to the session id.
- Step 6: nothing changes. A cancelled prompt is not an empty string.
- Step 7: bob gets **no `✎`** on that row. A contributor may well be allowed to rename, but the roster does not say who is a contributor and who is a viewer, and a control that works on half the rows it appears on is worse than one that appears on fewer.

**Why this matters:** four sessions called `smoke-session`, `ops-triage`, `repo-indexer`, `docs-writer` are legible; twelve hash-named ones are not, and the sidebar is the only place the binding between a name and a session lives.

---

## 9. Approval attribution

**Verifies:** #94 — approval attribution (v1.10.0, core-agent#830), specialist grants (v1.9.0, core-agent#768), honest subagent stop (v1.12.0, core-agent#897).

**Setup:** mock on :7778; `curl -X DELETE localhost:7778/_mock/perms-log` before and after.

The shared rule for all three: **absence means unknown, never none.**

**Steps**

1. Open `smoke-session` in solo. Run `/perms`.
2. Raise a permission prompt from outside the browser — the mock has no permission checker because it has no tools, so this is injected the way a turn is:
   ```
   curl -X POST localhost:7778/_mock/perms-prompt \
        -H 'Content-Type: application/json' \
        -d '{"session":"smoke-session","tool":"bash_exec","detail":"rm -rf ./build"}'
   ```
3. Answer the card that appears with **ALLOW ONCE**.
4. Run `/perms` again.
5. Run `/specialists`.
6. Run `/specialists researcher`, then `/specialists implementer`.
7. Run `/subagents stop researcher`, then `/subagents stop implementer`, then `/subagents stop ghost`.

**Expected**

- Step 1: `Permissions — mode ask`, the standing allow and deny patterns, and a two-row log. One row reads **`by smoke@example.com`**; the other reads **`unattributed`**. Both rows must be present — a log where every row had a name would let a client that assumes attribution look correct.
- Step 2: an inline card appears **in the transcript**, not as a modal, naming the tool and `rm -rf ./build`, with three buttons: DENY / ALLOW ONCE / ALLOW SESSION.
- Step 3: the buttons are replaced by the decision (`allow-once`) and, beside it, **`by smoke@example.com`** — who the *daemon* recorded, not who the browser thinks it is. The browser never sends an approver.
- Step 4: the log has grown by one row, naming `bash_exec` and the same identity. The card and the log agree.
- Step 5: two specialists. `researcher` summarises its grant as **`builtin 1 · gke 1`**; `implementer` reads **`grant unknown`** — never "no tools" — and a footer says *"1 report no grant, which is not the same as none"*.
- Step 6: `researcher` opens into its grant grouped by source. `implementer` says **`Tool grant: unknown`** and names **both** reasons — the daemon predates v1.9.0, *or* the specialist is configured with no tools of its own — because they lead to different next steps.
- Step 7: `researcher` → *`Stopped subagent "researcher". It ended as "stopped".`* `implementer` → *"had already finished before the stop arrived"*, **not** a claim that you stopped it. `ghost` → a reported failure, not a silent success.

**Why this matters:** the log is consulted precisely when something got through that should not have. The reader is the likeliest author of any given row and the most damaging one to guess, and the whole value of the line is that it was not guessed. Same rule, three surfaces.

---

## 10. Known not to work

A walkthrough that only lists successes trains you to skim. These are gaps, not bugs — if you hit one, it is the doc working.

- **`--auth-mode=oidc` is out of scope for v0.5.** Not blocked, not broken: not attempted. The mock's `mock_caller` cookie is the identity story this release has, and it is a development affordance, not an auth mechanism.
- **`/share` is refused on `ops-triage`, `repo-indexer` and `docs-writer` by default.** Those three are pinned to old conformance fixtures (1.2.0–1.4.0) and the ACL routes arrived in 1.10.0, so the command correctly says the backend cannot serve it. Append `?fixture=001-happy-turn` to the shell URL to get a modern backend. This is the version gate working, and it is worth seeing once on purpose.
- **The hold banner does not say how many background subagents are still running.** #70 asked for that line. There is nowhere truthful to read it from: the live roster carries no status, and the one number the wire does give (`interrupt`'s `running_subagents`) only arrives on a Stop, which does not hold. A zero that is always a zero is worse than nothing. Tracked in [#106](https://github.com/go-steer/mast-web/issues/106).
- **No `by` on an approval does not mean nobody approved it.** It means the daemon verified no identity for whoever answered. The client says `unattributed` rather than inventing one; against a pre-1.10.0 backend it says nothing at all and notes that the backend cannot attribute.
- **A cross-origin remote backend is not a supported shape.** Neither core-agent nor mast emits CORS headers. Loopback, or same-origin behind proxy mode. See [the deployment guide](./site/content/docs/deployment.md).
- **Session switching from inside a terminal is deliberately absent.** `/sessions` is read-only; the sidebar row is the switch gesture, because the shell is what knows the binding between a panel and a session.
- **Hosting is v0.6.** Anything about deploying this somewhere with real users is not in this release.

---

## Recording a run

Note the date, the commit, and one line per section: pass, fail, or near-miss with what you saw. A near-miss is the most valuable thing this document produces — it is the class of defect the automated suites structurally cannot find, and it is worth an issue even when you are not sure.

If a step here is mechanically checkable and is *not* already a Playwright spec under [`smoke/`](../smoke/), that is a gap in the suite, not a reason for this doc to exist. File it.
