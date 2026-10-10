# mast-web: manual walkthrough

**Status:** living. Re-run before every tag; update whenever a section stops matching what the screen does.

Everything else this repo verifies is verified by a machine. `dev/tools/ci` proves the units agree with each other and the Playwright suite proves the DOM does what the last person to touch it expected. **Neither of them looks at the screen.** This document is the part a person does: sit down, follow the list, and come away with a yes or a no on each capability.

It is written to be *run*, not read. Every section is **Setup → Steps → Expected → Why this matters**, and names the issue it verifies. "Expected" is deliberately specific — the failure this catches is the near-miss, the banner that is technically present and visually wrong, and you cannot notice a near-miss against a description that would also fit one.

Audience: someone who knows what mast-web is and wants to know whether this build is sound. Not a tutorial.

Sections 4 through 9 cover the v0.5.0 surface; §10 onwards is v0.6. What each of those changed, in prose, is [`CHANGELOG.md`](../CHANGELOG.md#050---2026-10-06); why it changed is [`v0.5-plan.md`](./v0.5-plan.md).

## Before you start

```
dev/tools/mock-backend           # SPA + fake attach backend, same origin, :7778
```

Then open <http://localhost:7778/>.

`npm run dev` is the *other* server — `--mode=static`, no backend at all, for pointing the SPA at a live daemon. Every section here uses the mock, because the mock is the only backend that can be put into the states this document is about (nobody verified, a subagent that already finished, two identities) on demand.

**If the mock is not on your laptop.** A Cloud Workstation, a devcontainer or an SSH box all work, because the mock serves the SPA *and* the attach API on one port — forward or proxy that one port and the browser is same-origin with its backend, which is the shape this SPA is built for. Substitute your forwarded origin for `localhost:7778` in every browser URL below; the `curl` commands stay as written, because they run **on the host the mock runs on**, not in your browser.

Two things to know before you read a failure:

- **Streaming is the thing a proxy breaks.** The mock sets `X-Accel-Buffering: no` and flushes every frame (`cmd/mast-web-server/mock.go`), but a buffering proxy in front will still collect the turn and deliver it in one block. If §1's text arrives all at once, suspect the hop before you suspect the client — and check it by running the mock locally once.
- **`localhost` exemptions do not apply.** The BFF's CSRF guard is proxy-mode only and the mock registers its routes bare, so writes are not refused. But if you later point this walkthrough at a *real* backend through a tunnel, that changes — see [§17](#17-known-not-to-work) on cross-origin backends.

The mock speaks **protocol 1.20.0** by default (since v0.7's #138) and replays `001-happy-turn`. Three of its four sessions are pinned to older fixtures on purpose — see [§17](#17-known-not-to-work).

**The two operators.** The mock reads a `mock_caller` cookie (`cmd/mast-web-server/mock_acl.go`) and answers `/sessions`, `/whoami` and the ACL routes accordingly. With no cookie you are `smoke@example.com`. To become the other one, open DevTools and run:

```js
localStorage.clear(); document.cookie = 'mock_caller=bob@example.com; path=/'; location.reload();
```

and to go back:

```js
localStorage.clear(); document.cookie = 'mock_caller=smoke@example.com; path=/'; location.reload();
```

The `localStorage.clear()` is there so one operator's saved tabs don't reopen as the other: a restored tab for a session the new identity can't see is confusing, not informative.

The cookie is the carrier rather than a header because the SPA's stream is an `EventSource`, and `EventSource` cannot set a header at all.

The roster the two of them share:

| session | owner | shared with | fixture |
|---|---|---|---|
| `smoke-session` | smoke@ | — | server default (1.19.0) |
| `ops-triage` | smoke@ | bob@ (viewer) | `003-tool-result-with-latency` |
| `repo-indexer` | smoke@ | — | `002-cost-ceiling-mid-turn` |
| `docs-writer` | bob@ | smoke@ (viewer) | `004-observer-mode-usage-update-only` |

So each operator sees one session they own and one somebody shared — neither branch can go unexercised — and each has sessions the other must never see.

**Resetting.** Five pieces of mock state survive a reload and will leak between sections if you let them:

```
curl -X DELETE localhost:7778/_mock/pause-gates      # holds, and any turn still playing
curl -X DELETE localhost:7778/_mock/turns            # back to turns that play and end (see §6)
curl -X DELETE localhost:7778/_mock/share-state      # ACL grants and renames
curl -X DELETE localhost:7778/_mock/perms-log        # approval log
curl -X DELETE localhost:7778/_mock/turn-requests    # inject/wake tally
curl -X DELETE localhost:7778/_mock/guardrails       # guardrail trips (v0.6)
```

**Clearing the browser side.** Run `localStorage.clear(); location.reload();` in the console. That resets the shell preference, tab layout and saved daemons, which is all mast-web keeps. **Don't** use DevTools' "Clear site data", and don't reach for an incognito window: a Cloud Workstation, an IAP or an SSO proxy in front of the mock keeps its login in a cookie, and both of those drop it. (Found on the first run, behind a Cloud Workstations proxy.)

---

## 1. A turn, start to finish

**Verifies:** the baseline. If this is wrong nothing below is worth checking.

**Setup:** mock on :7778; `localStorage.clear(); location.reload();` in the console (see *Clearing the browser side* above).

> **The reply is canned. It does not answer you.** `--mode=mock` replays
> [`001-happy-turn.jsonl`](../web/attach-core/conformance/fixtures/001-happy-turn.jsonl)
> frame by frame at 150ms, and there is no model behind it. Whatever you type,
> the assistant says `Hello world` and then calls `fs_read` on `/etc/hostname`.
> Your prompt *is* really posted — `/inject` is a live route and the tally in
> the next section counts it — but the response is a recording.
>
> That is deliberate and it is what makes the rest of this document
> checkable: every "Expected" below is a claim about **shape** — did it
> stream, did it appear once, is the cost a real number — and a backend that
> answered would make each of them depend on what a model felt like saying
> that morning. Read every step here as "does the client handle this frame
> correctly", never as "is the agent any good".

> **Slow the mock down for this section and for [§4](#4-stop).** The default
> pacing is 150ms per frame and the fixture is ten frames, so the whole turn
> is over in about a second and a half — the gap between the two text chunks
> is one 150ms tick, and the STOP button exists for barely longer. Neither is
> observable by a human at that speed, which makes two of the checks below
> unperformable as written. Restart with:
>
> ```
> dev/tools/mock-backend --frame-delay-ms=800
> ```
>
> An eight-second turn. Put it back to the default once you reach [§5](#5-the-hold) —
> nothing after §4 depends on watching a frame land, and the slow pacing just
> makes the rest tedious.
>
> **Hard-reload every open tab after any mock restart.** The SPA holds an
> `EventSource` against a process that no longer exists, and it does not
> always redraw as disconnected — but `submit()` refuses to dispatch when the
> connection is not live, so prompts vanish with no turn, no `SEND` greying
> out and no `STOP`. It looks exactly like a broken button. The tell is the
> wire, not the screen: `curl localhost:7778/_mock/turn-requests` stays `{}`
> because nothing was ever sent. This applies to every restart in this
> document, not just this one.

**Steps**

1. Open <http://localhost:7778/>.
2. Click the `smoke-session` row in the left sidebar.
3. Type anything into the composer and press Enter.
4. Wait for the turn to finish.

**Expected**

- The sidebar lists four sessions. Two of them (`ops-triage`, `docs-writer`) arrive already titled, so those rows lead with the title and carry the session id in a small dimmed slot **at the right-hand end of the same row**; the other two lead with the id. The row is one flex line (`.side-session` in `chrome.css`) — nothing in the sidebar wraps to a second line.
- The panel header shows the session, and the panel's **footer, bottom left**, reads **`⬤ connected`** — the glyph changes with the state (`◐ connecting`, `○ disconnected`), so what you are ruling out is a `◐` that never resolves. The window status bar carries the same state as a coloured dot for whichever panel is in front.
- Your prompt appears as your own message, once. (Twice is core-agent#639; the mock counts posts so `curl localhost:7778/_mock/turn-requests` should show a single `inject`.)
- **`Hello world`**, arriving as two chunks — `Hello`, a visible beat, then ` world` joining it on the same line — rather than in one block at the end. Watching it appear in pieces is the check; the words are not. (This is the check the frame-delay note above exists for, and the one a buffering proxy breaks.)
- Below it, a tool call rendered as a call and a result, not as raw JSON: `fs_read` with `{"path": "/etc/hostname"}`, answering `example.com`.
- A **`STOP`** button appears for the duration of the turn: same row as the input box, immediately to the right of `SEND`, small and outlined with **red** text. It is `hidden` between turns rather than disabled, so you are looking for it to *appear*, not to light up. At `--frame-delay-ms=800` it is on screen for about eight seconds; at the default you will barely catch it. If you would rather not watch for it, `document.querySelector('.term:not([hidden]) .term-stop').hidden` is `false` mid-turn and `true` either side.

  Worth knowing what it is bound to, because [§6](#6-status-truth) turns on the distinction: STOP follows `connection.isRunning` — *"this browser dispatched a turn"* — and not the session's actual run state. A turn another operator started will raise the status bar's running count without revealing STOP here, deliberately.
- A turn footer with **`45 in / 8 out`**, a latency, and a cost of **`$0.000120`** — six decimal places, because the fixture's cost is $0.00012 and two would round it to the `$0.00` that looks like a bug. What would be wrong is `$undefined`, or a footer that never lands.
- The window status bar along the bottom reads left to right: **`1 agent`**, the fleet counts, the session cost, and then the focused panel as `<session> · gemini-2.5-flash · T1` behind a connection dot. The model is shortened on purpose (a trailing `-20260101` date suffix is stripped). Hovering that segment gives the endpoint and the connection state as a tooltip. `mast-web-mock` — the daemon's `app` name — is the sidebar's group heading, not a status-bar field.

**Why this matters:** every other section assumes streaming, one-turn-per-prompt and a live footer. A failure here is not a feature bug, it is the client.

---

## 2. The chooser and the entry paths

**Verifies:** v0.4 plan §1 (`web/shell-select.js`), and #120 (step 6).

**Setup:** `localStorage.clear(); location.reload();` in the console. This whole section is about what the browser remembers, so it has to start empty. (Not "Clear site data", which signs you out of any proxy in front of the mock.)

**Steps**

1. Open `/`. Note which shell you land in.
2. Open `/?shell=spatial`. Note where you land.
3. Go back to `/` with no query.
4. In the spatial shell, use the HUD's shell link to switch to solo.
5. Open `/` again.
6. Open `/?shell=spacial&fixture=001-happy-turn` (the typo is the point), then click **spatial** on the page you get.
7. Disable JavaScript and open `/`.

**Expected**

| step | expected |
|---|---|
| 1 | **solo** — the default is the surface that works on a trackpad. |
| 2 | **spatial**. |
| 3 | **solo** again. A `?shell=` deep link must *not* have become your stored preference — sending someone a link to the room should not re-home them there. |
| 4 | solo, and the choice is stored (`localStorage['mast-web:shell']`). |
| 5 | **solo**, from the stored preference this time rather than the default. |
| 6 | You stay on `/`, on a plain page that reads **`There is no shell called "spacial". Pick one:`** above links to both shells. It doesn't silently land in solo, which would look like a broken link. The **spatial** link goes to `spatial.html?fixture=001-happy-turn`, so the rest of the query string survives, and it doesn't change your stored preference. |
| 7 | A plain page naming both shells with working links — not a blank page, not a 403, not a directory listing. |

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

- The turn stops, and the transcript says **`Turn canceled.`**: a plain line, **not** `Error: canceled: …` (that was a bug, fixed in #119; a cancel is something somebody asked for). The composer comes back and STOP disappears.
- **No hold banner appears.** Stop cancels; it does not park.
- The follow-up prompt starts a new turn straight away, with no gate to release first. `curl localhost:7778/_mock/turn-requests` should show exactly two `inject`s, one per prompt you sent. If it shows more, count your own prompts first: a prompt you sent and let finish before reading the next step counts too.

**Why this matters:** the wire distinction between a cancel and a park (`X-Interrupted`) is invisible in the UI, and that is correct — what an operator sees is the turn ending and the composer coming back. What would be wrong is Stop leaving the session in a state that needs a second gesture to escape.

---

## 5. The hold

**Verifies:** #70, and protocol v1.11.0's change (core-agent#878) that an inject no longer releases a hold.

**Setup:** mock on :7778; clear pause gates first and again afterwards — a held session leaks into the next section.

**Steps**

1. Open `smoke-session` in solo, and reset the tally: `curl -X DELETE localhost:7778/_mock/turn-requests`.
2. Run `/pause looking at the diff`.
3. Read the banner, and the bottom status bar.
4. Run `/tools`.
5. Type `actually use the other branch` (a plain message, not a command) and press Enter.
6. When that turn has finished, `/pause` again, then press **CONTINUE**.
7. `/pause` again, then press **ABANDON**.

**Expected**

Every transition below prints **exactly one line**. Two lines for one hold (`Session held — …` *and* `Held. /continue…`) was a race between the broadcast and the command's own reply, fixed in #123.

- Step 2: one line, **`Held. /continue to carry on, /abandon to drop the work, or type a correction to steer.`** The banner reads **`HELD — looking at the diff`** (if it says `operator paused`, the reason was dropped), with a detail line *"Nothing was in flight. No new turn starts until this is released."* and the time, a **CONTINUE** and an **ABANDON** button, and a hint *"…or type a correction to steer"*. The composer stays **enabled**, and its placeholder changes to `type a correction to steer, or /continue…`.
- Step 3: the **bottom** status bar (the strip along the window's lower edge, not the panel's own footer) shows **`1 held`** after the terminal count. It must **not** also say `running`: nothing is.
- Step 4: a slash command at a held session is still a command. `/tools` renders its catalog and **the banner stays up**.
- Step 5: a typed message at a held session is a **steer**, and a steer **releases** the hold with the correction first: your message, then **`Resumed — the correction goes in first.`**, the banner comes down, and a turn plays (the mock runs the correction). It went to `/resume`, not `/inject`: `curl localhost:7778/_mock/turn-requests` must still be `{}`. That's the 1.11.0 assertion in the form a person can perform. An inject would queue behind the gate forever, and the session would look like it swallowed your message.
- Step 6: **`Resumed — carrying on from where it stopped.`**, the banner is gone, and **no turn plays**, because nothing was held. (A mock that played one here was a bug, fixed in #121.)
- Step 7: **`Resumed — the held work was dropped.`** ABANDON is the same gesture as `/abandon`.

A hold set from **somewhere else** (another tab, core-tui's `/pause`, a curl) is narrated instead as `Session held — <reason>.` and `Session resumed (<mode>).`, once each.

**Why this matters:** "stop and let me look" is worth nothing if the only way out of the gate is to close the browser, which is what v0.4 shipped. And a hold whose composer is disabled cannot be steered, which is most of the point of holding.

---

## 6. Status truth

**Verifies:** #93 (protocol v1.12.0, core-agent#896).

**Setup:** mock on :7778; pause gates cleared; and **turns held open**:

```
curl -X POST localhost:7778/_mock/turns -H 'Content-Type: application/json' -d '{"open":true}'
```

By default the mock plays a turn and ends it, which is what §1–§5 want. Every turn here is somebody else's, watched arriving in a status poll up to ten seconds later, so it has to stay running until you stop it. Put it back afterwards: `curl -X DELETE localhost:7778/_mock/turns`.

Two things to have open: the solo shell, and a terminal for `curl`. Keep the tab **in front** while you watch. A hidden tab pauses its status polling, so a step done with the tab in the background has to be re-run.

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

- Step 2: the panel opens showing **`⟳ turn in flight`**, and the window's status bar reads **`1 running`**. There's **no STOP button** and SEND is enabled: the turn isn't yours, so you aren't offered a one-click cancel of somebody else's work. It must *not* open looking idle. No frame says this — the panel asks `GET /status` once on connect, because a turn that started a minute before you opened the tab announced itself to whoever was listening then.
- Step 3: the in-flight marker clears within a few seconds.
- Step 4: the marker appears **without a reload**, within about ten seconds — that is the idle poll cadence, and the point of the step is that a second read happens at all.
- Step 5: the hold banner appears (**`HELD — operator paused`**) **and** the in-flight marker stays up, with the detail line reading *"The turn it interrupted is still unwinding."* The status bar shows **both** `1 running` and `1 held`. One line in the transcript, `Session held — operator paused.`, since this hold came from outside the tab.

**Why this matters:** `state` has one slot and pause outranks running in it, so a session parked mid-turn reports `paused` and the bool beside it is the only thing that can say the turn is still going. A held session with nothing running is a session waiting for you; a held session with a turn behind the gate is still spending money. Collapsing those two is the bug the whole section exists for.

---

## 7. Sharing

**Verifies:** #91 (protocol v1.10.0, core-agent#797).

**Setup:** mock on :7778. This section switches identity twice; keep the DevTools console open.

**Steps**

1. As **smoke@** (no cookie, or the cookie set to `smoke@example.com`), open `/?shell=solo&fixture=001-happy-turn` and click `repo-indexer`. The fixture query matters: `repo-indexer` is otherwise pinned to a 1.4.0 capture and `/share` is correctly refused against it. (See [§17](#17-known-not-to-work) — and try it without the query once, on purpose.)
2. Run `/share`.
3. Run `/share viewer bob@example.com`.
4. Switch to **bob@** (the console line above, which also reloads).
5. Look for `repo-indexer` in bob's sidebar. Open it.
6. As bob, run `/share`.
7. Switch back to **smoke@**, reopen `/?shell=solo&fixture=001-happy-turn` → `repo-indexer`, and run `/share revoke bob@example.com`.
8. Switch to bob@.
9. Switch back to smoke@, so §8 starts as the owner.

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

- Step 3: the row now leads with **`tuesday incident`** and the session id **moves into the dimmed meta slot at the right-hand end of the same row** rather than disappearing — the id is what correlates a row with a URL or a log. (One flex line, not two; the sidebar never wraps.)
- Step 4: the row shows what the server **stored**, not what you typed — `spaced out`, trimmed.
- Step 5: the name clears and the row falls back to the session id.
- Step 6: nothing changes. A cancelled prompt is not an empty string.
- Step 7: bob gets **no `✎`** on that row. A contributor may well be allowed to rename, but the roster does not say who is a contributor and who is a viewer, and a control that works on half the rows it appears on is worse than one that appears on fewer.

**Why this matters:** four sessions called `smoke-session`, `ops-triage`, `repo-indexer`, `docs-writer` are legible; twelve hash-named ones are not, and the sidebar is the only place the binding between a name and a session lives.

---

## 9. Approval attribution

**Verifies:** #94 — approval attribution (v1.10.0, core-agent#830), specialist grants (v1.9.0, core-agent#768), honest subagent stop (v1.12.0, core-agent#897).

**Setup:** mock on :7778; `curl -X DELETE localhost:7778/_mock/perms-log` before and after.

**About step 2's prompt:** it's fake. The mock has no shell, so approving `rm -rf ./build` runs nothing and deletes nothing. It becomes a row in the mock's in-memory log and goes when that log is reset. (Asked on the first run, and fair to ask.)

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
- Step 2: an inline card appears **in the transcript**, not as a modal, naming the tool and `rm -rf ./build`, with three buttons: DENY / ALLOW ONCE / ALLOW SESSION, **readable in your theme** (they rendered in black before #127). If no card appears within a few seconds, send the curl again: the card arrives on a second connection, and a prompt raised before that connection has subscribed is lost (smoke/023 retries around the same race).
- Step 3: the buttons are replaced by the decision (`allow-once`) and, beside it, **`by smoke@example.com`** — who the *daemon* recorded, not who the browser thinks it is. The browser never sends an approver.
- Step 4: **`approved this session (3)`**, and the new row reads **`bash_exec rm -rf ./build [allow-once, by smoke@example.com]`**: the tool **and** what it was about to act on, and the same identity as the card. (The mock dropped the `rm -rf ./build` part before #126, so the operator had to ask what they'd allowed.)
- Step 5: two specialists. `researcher` summarises its grant as **`builtin 1 · gke 1`**; `implementer` reads **`grant unknown`** — never "no tools" — and a footer says *"1 report no grant, which is not the same as none"*.
- Step 6: `researcher` opens into its grant grouped by source. `implementer` says **`Tool grant: unknown`** and names **both** reasons — the daemon predates v1.9.0, *or* the specialist is configured with no tools of its own — because they lead to different next steps.
- Step 7: `researcher` → *`Stopped subagent "researcher". It ended as "stopped".`* `implementer` → *"had already finished before the stop arrived"*, **not** a claim that you stopped it. `ghost` → **`No subagent named "ghost" on this session. /subagents lists the ones it has.`**: a reported miss, never a silent success, and in words rather than the `POST … → HTTP 404` line it printed before #125.

**Why this matters:** the log is consulted precisely when something got through that should not have. The reader is the likeliest author of any given row and the most damaging one to guess, and the whole value of the line is that it was not guessed. Same rule, three surfaces.

---

## 10. Guardrail trips and the halt

**Verifies:** v0.6 #111 (protocol 1.13.0, core-agent#891; the halted inbox, core-agent#1040; per-turn trips, core-agent#1049).

**Setup:** mock on :7778, turns playing (the default); `curl -X DELETE localhost:7778/_mock/guardrails` before and after. The trips are raised from outside, the way a real cost ceiling or watchdog would raise them:

```
curl -X POST localhost:7778/_mock/guardrail-trip -H 'Content-Type: application/json' -d '<body>'
```

**Steps**

1. Open `smoke-session` in solo. Raise a watchdog halt at a turn boundary: body `{"session":"smoke-session","guardrail":"watchdog","halted_turn":false}`.
2. Read the transcript, the banner over the prompt, and the bottom status bar.
3. Type `are you still there?` and press Enter.
4. Run `/guardrail reset watchdog`. (Singular: that's the spelling the trip's own text uses, and mast-web answers to it.)
5. Raise a per-turn trip, which ends one turn and leaves the session running: body `{"session":"smoke-session","halts_session":false,"halted_turn":false}`.
6. Hold turns open (`curl -X POST localhost:7778/_mock/turns -H 'Content-Type: application/json' -d '{"open":true}'`), send a prompt, and while STOP is showing raise a trip that cuts it: body `{"session":"smoke-session"}`. Then put turns back (`curl -X DELETE localhost:7778/_mock/turns`) and run `/guardrails reset`.

**Expected**

- Step 1: a red-edged block in the transcript, **`⚠ guardrail tripped · watchdog`**, with the producer's reason under it **verbatim**: *"watchdog halted the agent (repeated-tool-call): looping on read_file with identical args. Clear it with /guardrail reset watchdog, or POST /sessions/{app}/{sid}/guardrails/reset."* Nothing of mast-web's is appended to it.
- Step 2: a **red banner** over the prompt, **`HALTED — watchdog`**, with the reason again and *"No turn runs until this is reset. Messages you send are queued and run after the reset. /guardrails reset clears it."* The status bar shows **`1 halted`**. The input stays usable, and its placeholder reads `halted — messages queue until the guardrail is reset…`.
- Step 3: your message, then **"The session is halted, so your message is queued. It runs as soon as the guardrail is reset, by you or by anyone else on this session. /guardrails reset clears it."** **SEND stays usable and STOP never appears.** This is the step that used to fail: in v0.5.0 the composer sat with STOP up until you reloaded, because the server queues the message and nothing ever ends a turn waiting on it.
- Step 4: **`Guardrails reset: watchdog`**, the banner comes down, `halted` leaves the status bar, and then **your queued message runs**: a reply arrives without you sending anything again.
- Step 5: a trip block whose reason ends *"…the session is NOT halted."*, and **no banner and no `halted`**. A trip isn't a halt; only the server's `GET /guardrails` says whether the session refuses turns.
- Step 6: the block reads **`⚠ guardrail tripped · cost_ceiling · the turn was cut`**, the turn ends (STOP goes, SEND comes back), and there is **no `Turn canceled.` line** under it: the trip already said why, so the cancel it caused is absorbed. The banner then appears, since this trip halted the session, and `/guardrails reset` clears it.

**Why this matters:** a halt is the moment an agent has spent too much or is looping. It's exactly when an operator most needs to be told why it stopped and how to get it going again, and against a current daemon v0.5.0 said only `Turn canceled.`, or nothing at all.

---

## 11. The permission card says what was applied

**Verifies:** v0.6 #112 (protocol 1.14.0, core-agent#1088; 1.17.0, #1179; 1.18.0, #1175).

**Setup:** mock on :7778; `curl -X DELETE localhost:7778/_mock/perms-log` before and after. Every prompt here is fake: the mock has no shell, and nothing runs.

**Steps**

1. Open `smoke-session` in solo. Raise a prompt the auto-mode approver model passed to you:
   ```
   curl -X POST localhost:7778/_mock/perms-prompt -H 'Content-Type: application/json' \
        -d '{"session":"smoke-session","tool":"bash","detail":"kubectl rollout restart deploy/api","approver_model":"claude-sonnet-5-5","approver_reason":"restarts production; the task did not ask for it"}'
   ```
2. Answer it with **ALLOW ONCE**.
3. Raise an ordinary prompt (the curl from §9 step 2). Before answering, expire it: `curl -X POST localhost:7778/_mock/perms-prompt-end -H 'Content-Type: application/json' -d '{"id":"<id from the raise>","why":"expired"}'`. Then click **ALLOW ONCE**.
4. Switch the session to auto mode, `curl -X POST localhost:7778/sessions/smoke-session/perms/mode -H 'Content-Type: application/json' -d '{"mode":"auto"}'`, and run `/perms`.

**Expected**

- Step 1: the card shows **"Passed to you by the approver model claude-sonnet-5-5"**, then the reason as a **quotation**, *restarts production; the task did not ask for it*, signed **`— claude-sonnet-5-5`**. It must never read as the daemon's own words. The buttons are **DENY, ALLOW ONCE and DENY…**, with **no ALLOW SESSION**: on such a prompt the daemon applies any allow as once, so a wider button would misstate what it does.
- Step 2: the outcome reads **`allow-once`** and `by smoke@example.com`. (When the daemon applies something other than what was clicked, for example a session grant turned into once, the card says **`applied as allow-once (asked for allow-session-tool)`** rather than repeating the click.)
- Step 3: the outcome turns red, **`not taken`**, and the transcript says **"Not taken: your answer arrived after the prompt expired, so the action did not run. Answer sooner, or raise approval_timeout."** A prompt whose turn was cut gets a different sentence ending *"look at why the turn ended"*, because answering sooner wouldn't have helped there.
- Step 4: **`Permissions — mode auto`**, and a row **`fs_read docs/runbook.md [allow-once, allowed by the approver model, claude-sonnet-5-5]`**. A call no person approved is credited to the model, never to a person and never as `unattributed`.

**Why this matters:** the card is a record of what happened. A card that echoes the click when the daemon applied something narrower tells the operator the wrong scope for something they just authorised. And a late approver's only question is whether the action went ahead.

---

## 12. Deny with a reason, and the permission mode

**Verifies:** v0.6 #113 (protocol 1.15.0, core-agent#1165; 1.16.0, #1168; `settable_modes`, 1.18.0).

**Setup:** mock on :7778; `curl -X DELETE localhost:7778/_mock/perms-log` before and after (it also puts the mode back to `ask`).

**Steps**

1. Open `smoke-session` in solo and raise a prompt (§9 step 2's curl).
2. Click **DENY…**, type `restart   the canary   first` (extra spaces on purpose), and press OK.
3. Raise another prompt, click **DENY…**, and press **Cancel**.
4. Run `/perms mode`, then `/perms mode yolo2`, then `/perms mode plan`, then `/perms`.
5. As bob@ (§7's console line), open `/?shell=solo&fixture=001-happy-turn` and click `ops-triage`, which bob can read but doesn't own, then run `/perms mode plan`. (The fixture matters: `ops-triage` is otherwise pinned to a recording older than 1.16.0, and mast-web would correctly say that backend can't change modes at all.)

**Expected**

- Step 2: the outcome reads **`deny`**, and under it **`reason: restart the canary first`**, collapsed to one line, exactly as the agent will read it.
- Step 3: nothing is sent. The card keeps its buttons, because DENY is the button for a deny without a reason.
- Step 4: *"Permission mode: ask. This session can be set to: ask, auto, acceptEdits, plan, yolo."*; then *"\"yolo2\" is not a mode this session can be set to…"* with nothing sent; then **"Permission mode: plan (was ask). Other tabs and clients keep showing the old mode until they re-read /perms, and a change made mid-turn takes effect when the turn ends."**; then `/perms` heads **`Permissions — mode plan`**.
- Step 5: **"Not changed: only this session's owner, or a daemon admin, can change its permission mode."** On this route the daemon refuses a non-owner with the same 404 as a session that doesn't exist; mast-web knows the version, so it can say what the 404 means.

**Why this matters:** a deny without a reason leaves the model guessing, and it tends to retry something near-identical. And a mode switch that doesn't say other tabs won't see it would leave a second operator looking at the wrong mode.

---

## 13. Failures survive a reload

**Verifies:** v0.6 #114 (protocol 1.19.0, core-agent#1258).

**Setup:** mock on :7778. The fixture below is a session replayed after two failures, all stamped last week, so they arrive as history.

**Steps**

1. Open `/?shell=solo&fixture=015-replayed-failures` and click `smoke-session`.
2. Read the history block at the top (*earlier in this session*).
3. Repeat §10 step 6 (a trip that cuts a turn) and count the trip blocks it produces.

**Expected**

- Step 2: both prompts, *summarise all forty incident reports* and *try again, twelve at a time*. Under the first, the trip block **`⚠ guardrail tripped · cost_ceiling · the turn was cut`** with its reason (*"…the session is NOT halted."*), and **no `Turn canceled` line**. Under the second, **`Turn error: rate_limited: quota exceeded`**. Before 1.19.0, and in v0.5.0 against any daemon, both turns would just stop, with no sign of why.
- Step 3: **one** trip block and no cancel line. Live, every failure arrives twice, as the typed frame and the event-log row. They share an id, and mast-web draws whichever comes first.

**Why this matters:** an operator who attaches after a failure, or reloads, is exactly the person who needs to see it, and until 1.19.0 the failure lived only in the daemon's log.

---

## 14. A result delivered before the run failed

**Verifies:** #108 (core-agent#1154). Unversioned: it's a key in a tool's result, and an older daemon never sends it.

**Setup:** mock on :7778.

**Steps**

1. Open `/?shell=solo&fixture=016-run-error` and click `smoke-session`.
2. Look at the `spawn_agent` tool row, then click it open.

**Expected**

- Step 2: the row reads **`✓ Used spawn_agent`**, not ✗ Failed, with one warning-coloured line under it: **`⚠ run failed after returning: 429 RESOURCE_EXHAUSTED: quota exceeded for model requests`**. Opened, the result still shows the subagent's `output` (*"Outage began 14:02 UTC…"*), unchanged.

**Why this matters:** the subagent delivered its work and *then* its run failed. Both are true. A red ✗ would tell the operator the result is junk, which is the misreading core-agent#1002 fixed for the model. A plain ✓ would hide the run failure from anyone who doesn't open the JSON.

---

## 15. Running subagents

**Verifies:** #139, #138 (protocol 1.20.0, core-agent#1283). Reads `GET /sessions/{sid}/agents` on the status chain: every 3 s while a subagent is running, every 10 s otherwise.

**Setup:** mock on :7778. The mock makes subagents on demand. Run these from a shell before step 1, so the first read on attach picks them up:

```sh
M=http://127.0.0.1:7778/_mock/subagent
curl -s $M -d '{"session":"smoke-session","name":"researcher","started_ago_s":125,"last_report":"reading pkg/attach/state.go\nand the rest"}'
curl -s $M -d '{"session":"smoke-session","name":"watcher","started_ago_s":900,"wake_in_s":240,"wake_detail":"poll the CI run again"}'
```

**Steps**

1. Open `/?shell=solo&fixture=001-happy-turn` and click `smoke-session`. Look between the transcript and the prompt.
2. Watch it for a few seconds.
3. Make two more: `curl -s $M -d '{"session":"smoke-session","name":"implementer"}'`, then the same with `"name":"reviewer"`. Wait up to 10 s.
4. Finish one: `curl -s $M -d '{"session":"smoke-session","name":"researcher","status":"failed","last_report":"quota exceeded"}'`. Wait a few seconds, then wait five more.
5. Switch to the spatial shell (`/?shell=spatial&fixture=001-happy-turn`), click `smoke-session`, then press **Esc** to send the panel back.
6. Clean up: `curl -s -X DELETE http://127.0.0.1:7778/_mock/subagents`.

**Expected**

| step | expected |
|---|---|
| 1 | Two rows, oldest first: **`◷ watcher · wakes in 3m5Xs · poll the CI run again`** then **`▶ researcher · 2m0Xs · reading pkg/attach/state.go`** (the first line of the report only; hover for all of it). The panel's status line and the window's status bar both read **`1 subagent running · 1 scheduled`**. |
| 2 | researcher's time counts up and watcher's countdown counts down, once a second, between polls. |
| 3 | Three rows at most: the last one reads **`+ 2 more · /subagents`**. The count reads `3 subagents running · 1 scheduled`. |
| 4 | Within ~3 s researcher's row turns red and reads **`✗ researcher · failed · quota exceeded`**, and the count drops by one at once. The row is gone about five seconds later. |
| 5 | In front, the bar is as in solo. Parked, the panel keeps **one** row (`3 subagents · /subagents`) and its status-line count. |
| 6 | Within 10 s the bar is gone and the counts with it. |

**Why this matters:** a hold or a STOP ends the parent's turn but not the background subagents, and until now nothing in mast-web showed they were there. core-tui has shown them for months. A sleeping subagent is counted as *scheduled*, not *running*, because "2 running" for two subagents asleep for ten minutes would be wrong. Only a subagent the bar watched finish gets the five-second row; a roster full of finished history on attach is not news.

---

## 16. Inline `/` autocomplete

**Verifies:** #43. No protocol: the list is the terminal's own gated command table, the one the palette (Ctrl/Cmd+P) reads.

**Setup:** mock on :7778.

**Steps**

1. Open `/?shell=solo&fixture=001-happy-turn`, click `smoke-session`, and type `/` in the prompt.
2. Keep typing: `/guar`.
3. Press **Down**, then **Enter**.
4. Clear the prompt, type `/help` and press **Enter** without touching the arrows.
5. Type `/who` and click the `/whoami` row.
6. Open `/?shell=spatial&fixture=001-happy-turn`, click `smoke-session`, type `/he`, then press **Esc** twice.

**Expected**

| step | expected |
|---|---|
| 1 | A list opens *over* the prompt (upward, not under it, so the panel's edge can't clip it): each command with its one-line help. Nothing is highlighted. |
| 2 | It narrows as you type, `/guardrails` first. Names that start with what you typed come before ones that only contain it. |
| 3 | Down highlights `/guardrails`; Enter puts **`/guardrails `** (with the space) in the prompt and closes the list. It does **not** run it, because most commands take arguments. |
| 4 | `/help` runs, as it always has. Enter accepts a row only if you moved to one. |
| 5 | The prompt reads `/whoami ` and keeps focus. |
| 6 | The first Esc closes the list and the panel stays in front. The second sends the panel back, as Esc always has. |

**Why this matters:** the command set grew from a handful to over twenty in three releases, and the palette is a chord most people never find. The list can't offer a command this backend would refuse, because it reads the same gated table the prompt dispatches from. And it changes nothing for anyone who types commands from memory: Enter is still send.

---

## 17. Known not to work

A walkthrough that only lists successes trains you to skim. These are gaps, not bugs — if you hit one, it is the doc working.

- **`--auth-mode=oidc` is out of scope** (v0.8, [#86](https://github.com/go-steer/mast-web/issues/86)). Not blocked, not broken: not attempted. The mock's `mock_caller` cookie is the identity story this release has, and it is a development affordance, not an auth mechanism.
- **`/share` is refused on `ops-triage`, `repo-indexer` and `docs-writer` by default.** Those three are pinned to old conformance fixtures (1.2.0–1.4.0) and the ACL routes arrived in 1.10.0, so the command correctly says the backend cannot serve it. Append `?fixture=001-happy-turn` to the shell URL to get a modern backend. This is the version gate working, and it is worth seeing once on purpose.
- **The hold banner doesn't count running subagents yet.** The bar in §15 shows them; the banner's *"N subagents still running"* is [#106](https://github.com/go-steer/mast-web/issues/106), next in v0.7.
- **No `by` on an approval does not mean nobody approved it.** It means the daemon verified no identity for whoever answered. The client says `unattributed` rather than inventing one; against a pre-1.10.0 backend it says nothing at all and notes that the backend cannot attribute.
- **A cross-origin remote backend is not a supported shape.** Neither core-agent nor mast emits CORS headers. Loopback, or same-origin behind proxy mode. See [the deployment guide](./site/content/docs/deployment.md).
- **Session switching from inside a terminal is deliberately absent.** `/sessions` is read-only; the sidebar row is the switch gesture, because the shell is what knows the binding between a panel and a session.
- **Hosting is v0.8.** v0.6 became the protocol catch-up and v0.7 is about running subagents. Anything about deploying this somewhere with real users is not in this release.
- **mast-web and the mock both speak protocol 1.20.0** (§10–§13, §15). A refusal-storm row (`gate/refusal-storm`) isn't drawn on its own, because its metadata isn't documented upstream; the cancel it causes says `Turn canceled (cut by refusal_storm).`, which carries the same fact.
- **A real core-agent won't start token-less with `bash` any more** (core-agent#1266). `core-agent --attach-listen :7777` now exits 2 unless the listener is authenticated. This walkthrough is unaffected because it uses the mock. If you point it at a real daemon, pass a token (`--attach-token-file`) and give the same token to mast-web.

---

## Recording a run

Note the date, the commit, and one line per section: pass, fail, or near-miss with what you saw. A near-miss is the most valuable thing this document produces — it is the class of defect the automated suites structurally cannot find, and it is worth an issue even when you are not sure.

If a step here is mechanically checkable and is *not* already a Playwright spec under [`smoke/`](../smoke/), that is a gap in the suite, not a reason for this doc to exist. File it.

### Runs

**2026-10-07 → 2026-10-08**, first complete run, by the operator, through a Cloud Workstations proxy, against `main` as it moved from `600a40d` to `14c0e11` (each fix below landed during the run and was re-checked on screen). Mock at `--frame-delay-ms=800`.

| § | Result | Found |
|---|---|---|
| 1 | pass, after fixes | The mock never ran a turn in response to a prompt; STOP never got a cancel back (#118). A cancel rendered as `Error: canceled: …` (#119). |
| 2 | pass | A mistyped `?shell=` silently lands in solo (#120, filed). |
| 3 | pass, after fixes | `/help`'s columns were padded text that wrapped under the names (#122). |
| 4 | pass | — |
| 5 | pass, after fixes | CONTINUE played a turn nobody asked for (#121). Every hold printed two lines (#123). `1 running` stuck after a turn ended in an error (#124). |
| 6 | pass | — |
| 7 | pass | — |
| 8 | pass | — |
| 9 | pass, after fixes | A 404 on `/subagents stop` printed the HTTP line (#125). The approval log dropped what was approved (#126). The card's buttons rendered black on a dark theme (#127). |
| 10 | read | Hosting moved to v0.7; two v0.6 regressions and core-agent#1266 added. |

The doc itself had about eight wrong expected strings, all written from intent rather than read off `web/`. They're corrected above. The lesson: quote the code, not the plan.

**§10–§14 (v0.6) have not had a human run yet.** Each was written in the same PR as its feature, with every quoted string read off `web/`. Each is also covered by a smoke spec (`025`, `023`, `026`, `027`), and the v0.6 browser was run once against a real core-agent (protocol 1.20.0, echo provider). None of that is a person looking at the screen.
