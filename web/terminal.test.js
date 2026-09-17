// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Unit tests for web/terminal.js's client-side slash registry.
//
// The rest of terminal.js is a renderer bound to a live SSE stream and
// belongs to the smoke suite; this covers the one part that is a
// decision rather than a drawing — which commands exist, which of them
// this backend can serve, and who answers a given name. #45's whole
// content is that those three questions have one answer each, so they
// are worth asserting somewhere faster than Playwright.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const load = (rel) => new Function('window', readFileSync(join(here, rel), 'utf8'))(globalThis);

// A client that records calls and answers with fixed payloads. The
// terminal only ever reaches the network through this object, so
// stubbing it is enough to run every built-in end to end.
function stubClient() {
  const calls = [];
  // The ACL is stored rather than fixed, because the endpoint's own
  // contract is that a PATCH echoes what was STORED — a stub that
  // answered with the request body would let a command that renders
  // its own optimism pass.
  const acl = { owner: 'alice@example.com', viewers: ['bob@example.com'], contributors: [] };
  const record =
    (name, value) =>
    async (...args) => {
      calls.push({ name, args });
      if (typeof value === 'function') return value(...args);
      return value;
    };
  return {
    calls,
    endpoint: '/',
    listTools: record('listTools', [
      { name: 'fs_read', source: 'builtin', description: 'Read files', gate_state: 'allowed' },
      { name: 'gh_pr_view', source: 'mcp', server: 'github', description: 'Show a PR' },
    ]),
    // Two rows, one with a `tools` grant and one without, because the
    // missing key is the case #768 is about: it means unknown, and a
    // catalog where every row had one would let a renderer that prints
    // "no tools" for a blank pass.
    listConfiguredSubagents: record('listConfiguredSubagents', [
      {
        name: 'researcher',
        description: 'Research',
        model: 'm-1',
        modes: ['sync', 'async'],
        tools: [{ name: 'fs_read', source: 'builtin', description: 'Read files' }],
      },
      { name: 'implementer', description: 'Write code', modes: ['async'] },
    ]),
    stopSubagent: record('stopSubagent', (name) => ({
      session: 's1',
      agent: name,
      stopped: true,
      status: 'stopped',
    })),
    // The approval log, with both attribution cases on it.
    getPerms: record('getPerms', {
      mode: 'ask',
      allow: ['fs_read'],
      deny: [],
      approvals: [
        {
          tool: 'bash_exec',
          key: 'git push',
          decision: 'allow-session-tool',
          by: 'ada@example.com',
          at: '2026-09-17T10:00:00Z',
        },
        { tool: 'fs_write', decision: 'allow-once', at: '2026-09-17T10:05:00Z' },
      ],
    }),
    listSessions: record('listSessions', [
      { id: 's1', app: 'demo', status: 'active', lastTouchedAt: '2026-09-01T10:00:00Z', title: '' },
      {
        id: 's2',
        app: 'demo',
        status: 'idle',
        lastTouchedAt: '2026-09-02T10:00:00Z',
        title: 'Later one',
      },
    ]),
    getGuardrails: record('getGuardrails', {
      watchdog: { mode: 'warn', tripped: false },
      cost_ceiling: { session_cost_usd: 0.02, max_session_usd: 10, tripped: false },
      halted: false,
    }),
    resetGuardrails: record('resetGuardrails', { ok: true, reset: ['watchdog'] }),
    getUsage: record('getUsage', { overall: { turns: 1 } }),
    whoami: record('whoami', { identity: 'alice@example.com' }),
    // The hold's two routes, plus the poll the banner reads
    // turn_in_flight from. Defaults are the ordinary answers; a test
    // that cares about a different one overwrites the method.
    // PauseResponse's keys are the prefixed ones — paused_since and
    // pause_reason, not since and reason. Spelled correctly here so a
    // consumer that reads the frame's names instead fails a test rather
    // than quietly rendering undefined.
    pause: record('pause', (reason) => ({
      session: 's1',
      paused: true,
      transitioned: true,
      state: 'paused',
      pause_reason: reason || 'operator hold',
      paused_since: '2026-09-17T12:00:00Z',
    })),
    resume: record('resume', (mode) => ({
      session: 's1',
      resumed: true,
      mode: mode || 'continue',
      state: 'running',
    })),
    getStatus: record('getStatus', { state: 'paused', turn_in_flight: false }),
    // The 1.10.0 ACL. Both lists are always present on the wire, so
    // they are always present here.
    acl,
    getACL: record('getACL', () => ({
      owner: acl.owner,
      viewers: acl.viewers.slice(),
      contributors: acl.contributors.slice(),
    })),
    patchACL: record('patchACL', (patch) => {
      // Absent means leave alone, which is the half of PATCH a PUT
      // would lose — modelled here so a caller that sends a list it
      // did not touch is not silently indistinguishable.
      if (patch && Array.isArray(patch.viewers)) acl.viewers = patch.viewers.slice();
      if (patch && Array.isArray(patch.contributors)) acl.contributors = patch.contributors.slice();
      return {
        owner: acl.owner,
        viewers: acl.viewers.slice(),
        contributors: acl.contributors.slice(),
      };
    }),
    protocolAtLeast: () => true,
    _post: record('_post', { _render: 'text', body: 'ok' }),
    disconnect() {},
  };
}

// One turn of the event loop, for the paths that fire a request and
// redraw when it lands (refreshTurnInFlight).
const flush = () => new Promise((r) => setTimeout(r, 0));

// The version the mock speaks, and the one the version-gated rows in
// the table are written against. A test that wants an older backend
// passes `protocol` — that is the whole difference between a daemon
// with the 1.10.0 ACL routes and one without.
const WIRE_VERSION = '1.12.0';

function mount({ features, slashCommands, commands, protocol } = {}) {
  const client = stubClient();
  globalThis.AttachClient = function (opts) {
    // Keep the frame sink the terminal handed us, so a test can push a
    // `pause` or `status-update` frame the way a live stream would.
    client.feed = opts.onEvent;
    // And the connection callback, which is the real stream's way of
    // saying "attached" — the one thing that starts the status poll.
    // mount() sets the store directly instead, so a test that does not
    // ask for the poll does not get one.
    client.conn = opts.onConnectionState;
    return client;
  };
  const term = globalThis.MastTerminal.create({
    endpoint: '/',
    sessionId: 's1',
    commands: commands,
  });
  document.body.appendChild(term.el);
  term.connection.setState('connected');
  term.session.setCapabilities({
    protocol_version: protocol === undefined ? WIRE_VERSION : protocol,
    features: features,
    slash_commands: slashCommands || [],
  });
  return {
    term,
    client,
    text: () => term.out.textContent,
    hold: () => term.el.querySelector('.term-hold'),
  };
}

describe('MastTerminal built-ins', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    load('attach-core/protocol.js');
    load('attach-core/replay.js');
    load('state/subscriptions.js');
    load('state/session.js');
    load('state/connection.js');
    load('slash-render.js');
    load('terminal.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('/help and dispatch read the same table', () => {
    it('lists every built-in when the backend gates nothing', async () => {
      const { term, text } = mount({ features: { guardrails: true } });
      await term.submit('/help');
      for (const name of [
        '/help',
        '/clear',
        '/export',
        '/tools',
        '/mcp',
        '/subagents',
        '/perms',
        '/specialists',
        '/sessions',
        '/guardrails',
        '/model',
        '/usage',
        '/whoami',
      ]) {
        expect(text()).toContain(name);
      }
      expect(text()).not.toContain('Not supported by this backend');
    });

    // §2.1's additive rule: silence is consent. A 2026-02 backend that
    // has never heard of the flag keeps the command.
    it('treats an absent features map, and an absent key, as on', async () => {
      const { term, text } = mount({ features: undefined });
      await term.submit('/help');
      expect(text()).toContain('/mcp');
      expect(text()).not.toContain('Not supported by this backend');

      const second = mount({ features: { pause: true } });
      await second.term.submit('/help');
      expect(second.text()).toContain('/guardrails');
    });

    it('drops a gated-off command from /help and names it in the footer', async () => {
      const { term, text } = mount({ features: { mcp: false, specialists: false } });
      await term.submit('/help');
      expect(text()).not.toContain('MCP servers and what each contributes');
      expect(text()).toContain('Not supported by this backend: /mcp, /specialists');
    });

    // The pair that makes this #45 and not a cosmetic change: the same
    // available() call decides both, so a command cannot be listed and
    // then refuse (core-tui#275/#276).
    it('refuses a gated-off command by name, without calling the backend', async () => {
      const { term, client, text } = mount({ features: { mcp: false } });
      await term.submit('/mcp');
      expect(text()).toContain('/mcp is not supported by this backend.');
      expect(text()).not.toContain('Unknown command');
      expect(client.calls).toEqual([]);
    });

    it('still reports an unknown name as unknown', async () => {
      const { term, text } = mount({ features: {} });
      await term.submit('/nope');
      expect(text()).toContain('Unknown command: /nope');
    });
  });

  describe('precedence and case', () => {
    it('shadows an advertised name that collides with a built-in', async () => {
      const { term, client, text } = mount({ features: {}, slashCommands: ['tools'] });
      await term.submit('/tools');
      expect(client.calls.map((c) => c.name)).toEqual(['listTools']);
      expect(text()).toContain('Tools (2)');
    });

    // Built-ins are ours to spell; an advertised name is the agent's and
    // is matched exactly, so /Compact is never posted to a backend that
    // only answers /compact.
    it('matches built-ins case-insensitively and advertised names exactly', async () => {
      const { term, client, text } = mount({ features: {}, slashCommands: ['compact'] });
      await term.submit('/WhoAmI');
      expect(client.calls.map((c) => c.name)).toEqual(['whoami']);

      await term.submit('/Compact');
      expect(text()).toContain('Unknown command: /Compact');

      await term.submit('/compact');
      expect(client.calls.map((c) => c.name)).toEqual(['whoami', '_post']);
    });
  });

  describe('the connection gate', () => {
    it('lets the display-only commands run on a dead connection', async () => {
      const { term, text } = mount({ features: {} });
      term.connection.setState('disconnected');
      await term.submit('/help');
      expect(text()).toContain('/tools');
      expect(text()).not.toContain('Not connected.');
    });

    it('holds back the ones that need a backend', async () => {
      const { term, client, text } = mount({ features: {} });
      term.connection.setState('disconnected');
      await term.submit('/tools');
      expect(text()).toContain('Not connected.');
      expect(client.calls).toEqual([]);
    });

    it('clears the panel offline', async () => {
      const { term, text } = mount({ features: {} });
      await term.submit('/whoami');
      expect(text()).toContain('alice@example.com');
      term.connection.setState('disconnected');
      await term.submit('/clear');
      expect(text()).toBe('');
    });
  });

  describe('the ported commands', () => {
    it('/mcp buckets the catalog by server', async () => {
      const { term, text } = mount({ features: {} });
      await term.submit('/mcp');
      expect(text()).toContain('MCP servers (1)');
      expect(text()).toContain('github');
      // fs_read is a built-in, not a server called "fs".
      expect(text()).not.toContain('fs —');
    });

    it('/specialists tags each row with model and modes', async () => {
      const { term, text } = mount({ features: {} });
      await term.submit('/specialists');
      expect(text()).toContain('researcher');
      expect(text()).toContain('m-1');
      expect(text()).toContain('sync/async');
    });

    it('/sessions sorts by recency, titles what it can, marks this panel', async () => {
      const { term, text } = mount({ features: {} });
      await term.submit('/sessions');
      const out = text();
      expect(out).toContain('Sessions (2)');
      expect(out.indexOf('Later one')).toBeLessThan(out.indexOf('s1'));
      expect(out).toContain('this panel');
      // The roster is cached for the app-qualified lookups that need it.
      expect(term.session.get().sessions).toHaveLength(2);
    });

    it('/guardrails reports state and resets on request', async () => {
      const { term, client, text } = mount({ features: { guardrails: true } });
      await term.submit('/guardrails');
      expect(text()).toContain('mode=warn tripped=false');

      term.session.setCostCeilingHit(true);
      await term.submit('/guardrails reset cost_ceiling 5');
      expect(text()).toContain('Guardrails reset: watchdog');
      // A reset that doesn't unfreeze the input hasn't reset anything
      // the operator can see.
      expect(term.session.get().costCeilingHit).toBe(false);
      expect(client.calls.at(-1).args[0]).toEqual({
        guardrail: 'cost_ceiling',
        additionalBudgetUsd: 5,
      });
    });

    // 409 is a structured refusal, not a transport failure — the client
    // resolves it with ok:false and the message is the useful part.
    it('/guardrails reset relays a refusal that would re-trip', async () => {
      const { term, client, text } = mount({ features: { guardrails: true } });
      client.resetGuardrails = async () => ({ ok: false, message: 'would re-trip at $12' });
      await term.submit('/guardrails reset');
      expect(text()).toContain('would re-trip at $12');
      expect(term.session.get().costCeilingHit).toBe(false);
    });

    it('/model reports the model without pretending it can change it', async () => {
      const { term, text } = mount({ features: {} });
      term.session.setCurrentModel('mock-model-1.5');
      await term.submit('/model');
      expect(text()).toContain('mock-model-1.5');
      expect(text()).toContain('does not exist yet');
    });

    // capabilities.agent used to be a sidebar slot in index.html. #61
    // deleted that document, and the field came here — /model is
    // already the question it answers.
    it('/model names the agent behind the model', async () => {
      const { term, text } = mount({ features: {} });
      term.session.setCapabilities({
        features: {},
        agent: {
          name: 'mast',
          version: '0.1.0-dev',
          description: 'Lean fork of core-agent, orchestration-first',
          model: 'gemini-2.5-pro',
          provider: 'vertex',
        },
      });
      term.session.setCurrentModel('gemini-2.5-pro');
      await term.submit('/model');
      expect(text()).toContain('Agent: mast 0.1.0-dev (gemini-2.5-pro via vertex)');
      expect(text()).toContain('Lean fork of core-agent');
    });

    // A backend that says nothing about itself gets no empty header
    // line — the pre-#61 slot hid itself, and so does this.
    it('/model says nothing about an agent the backend did not describe', async () => {
      const { term, text } = mount({ features: {} });
      term.session.setCurrentModel('mock-model-1.5');
      await term.submit('/model');
      expect(text()).not.toContain('Agent:');
    });

    it('/export rejects a format it cannot produce', async () => {
      const { term, text } = mount({ features: {} });
      await term.submit('/export csv');
      expect(text()).toContain('Usage: /export [json|md]');
    });

    // Scoped to this panel's own transcript. app.js queried the whole
    // document, which in a workspace exports whatever is on screen.
    it('/export scrapes only this panel', async () => {
      const clicked = [];
      // jsdom implements neither, and a download is the whole point.
      globalThis.URL.createObjectURL = () => 'blob:x';
      globalThis.URL.revokeObjectURL = () => {};
      vi.spyOn(globalThis.HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
        clicked.push(this.download);
      });

      const mine = mount({ features: {} });
      const other = mount({ features: {} });
      await other.term.submit('/model');
      await other.term.submit('/model');
      await mine.term.submit('/whoami');
      await mine.term.submit('/export');

      expect(clicked).toEqual(['mast-session-s1.json']);
      // One row: this panel's /whoami. The other panel's two are not
      // in the count, and a document-wide query would have made it three.
      expect(mine.text()).toContain('Exported 1 row as json.');
    });
  });

  // PR 3b: a shell (shell.js, or app.js before it) contributes commands
  // that act on the window. The point of passing them in rather than
  // letting the shell keep its own list is that they land in this
  // table, so every question about "what commands exist" still has one
  // answer — which is #45 again, one level up.
  describe('shell-contributed commands', () => {
    const shellCmd = (over) => ({
      name: 'layout',
      usage: '/layout [id]',
      help: 'Transcript arrangement',
      offline: true,
      run: () => {},
      ...over,
    });

    it('dispatches one, and hands it somewhere to answer', async () => {
      const seen = [];
      const cmd = shellCmd({
        run: (args, io) => {
          seen.push(args);
          io.print('Layout: ' + args[0]);
        },
      });
      const { term, text } = mount({ features: {}, commands: [cmd] });
      await term.submit('/layout chat');
      expect(seen).toEqual([['chat']]);
      expect(text()).toContain('Layout: chat');
    });

    it('lists them under their own heading in /help', async () => {
      const { term, text } = mount({ features: {}, commands: [shellCmd()] });
      await term.submit('/help');
      expect(text()).toContain('This shell:');
      expect(text()).toContain('/layout [id]');
      // Still one list: the built-ins did not move out of it.
      expect(text()).toContain('/clear');
    });

    // /clear has to mean the same thing in every panel of every shell.
    // A shell that could redefine it would make that a per-page
    // question, which is exactly the ambiguity this table exists to
    // remove.
    it('refuses to let a shell shadow a built-in', async () => {
      const hijack = shellCmd({
        name: 'clear',
        run: () => {
          throw new Error('ran');
        },
      });
      const { term, text } = mount({ features: {}, commands: [hijack] });
      await term.submit('/whoami');
      await term.submit('/clear');
      expect(text()).toBe('');
    });

    it('puts them behind the same capability gate as the built-ins', async () => {
      const gated = shellCmd({ name: 'roomy', usage: '/roomy', feature: 'spatial' });
      const { term, text } = mount({ features: { spatial: false }, commands: [gated] });
      await term.submit('/help');
      expect(text()).toContain('Not supported by this backend: /roomy');
      await term.submit('/roomy');
      expect(text()).toContain('/roomy is not supported by this backend.');
    });

    it('ignores a malformed descriptor rather than breaking the table', async () => {
      const { term, text } = mount({
        features: {},
        commands: [{ name: 'nope' }, null, shellCmd()],
      });
      await term.submit('/help');
      expect(text()).toContain('/layout [id]');
      expect(text()).not.toContain('/nope');
    });

    // What the command palette reads. A palette that offers a name the
    // prompt would then refuse is the second read this whole table
    // exists to prevent, so it comes from here rather than from a list
    // the shell keeps alongside.
    it('reports the live, gated table through api.commands', () => {
      const { term } = mount({
        features: { mcp: false },
        slashCommands: ['compact'],
        commands: [shellCmd()],
      });
      const names = term.commands.map((c) => c.name);
      expect(names).toContain('layout');
      expect(names).toContain('help');
      expect(names).toContain('compact');
      expect(names).not.toContain('mcp');

      const bySource = Object.fromEntries(term.commands.map((c) => [c.name, c.source]));
      expect(bySource.layout).toBe('shell');
      expect(bySource.help).toBe('builtin');
      expect(bySource.compact).toBe('agent');
    });
  });

  // The batch runner is the caller that needs this: it drives a queue
  // of prompts and has to know what each one cost. Everything else
  // ignores the return value.
  describe('submit() reports the turn back to its caller', () => {
    it('returns null when no turn happened', async () => {
      const { term } = mount({ features: {} });
      expect(await term.submit('/help')).toBeNull();
      expect(await term.submit('   ')).toBeNull();
      term.connection.setState('disconnected');
      expect(await term.submit('hello')).toBeNull();
    });

    it("returns the turn's measurements when it closes", async () => {
      const { term, client } = mount({ features: {} });
      client.inject = async () => {};
      const pending = term.submit('hello');
      // runPrompt registers the turn synchronously; a live stream would
      // close it from a turn-complete frame.
      term.connection.getActiveTurn().finish({
        totalMs: 1200,
        tokens: { in: 30, out: 90 },
        costUSD: 0.0042,
        toolCalls: 2,
      });
      const r = await pending;
      expect(r.ok).toBe(true);
      expect(r.totalMs).toBe(1200);
      expect(r.tokens).toEqual({ in: 30, out: 90 });
      expect(r.costUSD).toBe(0.0042);
      // Nothing streamed, so there was no first frame before the close;
      // the total is the honest answer rather than a zero.
      expect(r.ttfbMs).toBe(1200);
    });

    it('returns null at a held session, because a steer is not a turn', async () => {
      const { term, client } = mount({ features: { pause: true } });
      client.feed({ type: 'pause', data: { state: 'paused' } });
      expect(await term.submit('actually, use the other file')).toBeNull();
    });

    it('returns the failure instead of throwing it', async () => {
      const { term, client, text } = mount({ features: {} });
      client.inject = async () => {
        throw new Error('socket died');
      };
      const r = await term.submit('hello');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('socket died');
      // And it is still rendered, because the other callers of submit()
      // are keypresses with nobody to catch a rejection.
      expect(text()).toContain('socket died');
    });
  });

  // #70. A hold is the one piece of session state that changes what
  // every other control means, so the tests below are mostly about
  // which surface says what: the banner draws the state, the `pause`
  // frame narrates the transition, and exactly one of them does each.
  describe('the hold', () => {
    const paused = (over) => ({ type: 'pause', data: { state: 'paused', ...over } });

    it('/pause holds, carries the reason, and names the ways out', async () => {
      const { term, client, text, hold } = mount({ features: { pause: true } });
      await term.submit('/pause looking at the diff');
      expect(client.calls.map((c) => c.name)).toContain('pause');
      expect(client.calls.find((c) => c.name === 'pause').args[0]).toBe('looking at the diff');
      expect(text()).toContain('/continue');
      expect(text()).toContain('/abandon');
      expect(text()).toContain('steer');
      // The route's own post-condition put the banner up; no frame has
      // arrived yet and the operator should not have to wait for one.
      expect(hold().hidden).toBe(false);
      expect(hold().textContent).toContain('HELD — looking at the diff');
      expect(hold().textContent).toContain('Held since');
      expect(term.state.paused).toBe(true);
    });

    // A bare /pause takes whatever reason the backend supplied, which
    // is the string the next operator to find this session will read.
    it('renders the reason the server stored, not the one we sent', async () => {
      const { term, hold } = mount({ features: { pause: true } });
      await term.submit('/pause');
      expect(hold().textContent).toContain('HELD — operator hold');
    });

    // Idempotent upstream, and saying "held" twice would imply this
    // press is what did it.
    it('/pause reports an already-held session as already held', async () => {
      const { term, client, text } = mount({ features: { pause: true } });
      client.pause = async () => ({ paused: true, transitioned: false });
      await term.submit('/pause');
      expect(text()).toContain('Already held');
    });

    // The two facts an operator asks for in order, and the reason
    // turn_in_flight is a separate field from the gate at all.
    it('says whether the turn it interrupted is still running', async () => {
      const { term, client, hold } = mount({ features: { pause: true } });
      client.getStatus = async () => ({ state: 'paused', turn_in_flight: true });
      client.feed(paused({ interrupted: true, reason: 'cost ceiling' }));
      await flush();
      expect(hold().textContent).toContain('still unwinding');
      expect(term.state.turnInFlight).toBe(true);
    });

    it('distinguishes a cancelled turn from a gate over nothing', async () => {
      const a = mount({ features: { pause: true } });
      a.client.feed(paused({ interrupted: true }));
      await flush();
      expect(a.hold().textContent).toContain('was cancelled');

      const b = mount({ features: { pause: true } });
      b.client.feed(paused());
      await flush();
      expect(b.hold().textContent).toContain('Nothing was in flight');
    });

    // Exactly one surface narrates, or every park is announced twice:
    // the `pause` frame and the status poll carry the same fact about a
    // second apart.
    it('narrates a transition once, and a repeat of the same state never', async () => {
      const { client, text } = mount({ features: { pause: true } });
      client.feed(paused({ reason: 'operator' }));
      await flush();
      expect(text().match(/Session held/g)).toHaveLength(1);

      client.feed(paused({ reason: 'operator' }));
      client.feed({ type: 'status-update', data: { turn_state: 'paused' } });
      await flush();
      expect(text().match(/Session held/g)).toHaveLength(1);
    });

    it('narrates the release, with the disposition that was applied', async () => {
      const { client, text, hold } = mount({ features: { pause: true } });
      client.feed(paused());
      await flush();
      client.feed({ type: 'pause', data: { state: 'resumed', mode: 'abandon' } });
      expect(text()).toContain('Session resumed (abandon)');
      expect(hold().hidden).toBe(true);
    });

    it('/continue and /abandon send their mode, and /cont is /continue', async () => {
      const { term, client, text } = mount({ features: { pause: true } });
      client.feed(paused());
      await flush();

      await term.submit('/continue');
      expect(client.calls.at(-1)).toEqual({ name: 'resume', args: ['continue', undefined] });
      expect(text()).toContain('carrying on from where it stopped');

      await term.submit('/cont');
      expect(client.calls.at(-1)).toEqual({ name: 'resume', args: ['continue', undefined] });

      await term.submit('/abandon');
      expect(client.calls.at(-1)).toEqual({ name: 'resume', args: ['abandon', undefined] });
      expect(text()).toContain('the held work was dropped');
    });

    // An alias dispatches but is not a second row: /help would otherwise
    // list the same command twice under two spellings.
    it('lists /continue once, mentioning the alias in its help', async () => {
      const { term, text } = mount({ features: { pause: true } });
      await term.submit('/help');
      expect(text().match(/\/continue/g)).toHaveLength(1);
      expect(text()).toContain('alias /cont');
      expect(term.commands.map((c) => c.name)).not.toContain('cont');
    });

    // The whole point of the mode vocabulary: typing IS the third one.
    it('steers on typed text instead of starting a turn', async () => {
      const { term, client, text } = mount({ features: { pause: true } });
      client.feed(paused());
      await flush();
      await term.submit('use the other file');

      expect(client.calls.at(-1)).toEqual({
        name: 'resume',
        args: ['steer', 'use the other file'],
      });
      // Drawn, because the live echo of an operator's own prompt is
      // suppressed and nothing else would render it.
      expect(text()).toContain('use the other file');
      // And NOT run here. mast-web reads a standing stream, so the host
      // runs the steer; a client that also ran it would send it twice.
      expect(client.calls.map((c) => c.name)).not.toContain('inject');
      expect(term.connection.getActiveTurn()).toBeFalsy();
    });

    // core-tui#289: deciding "is this a command" from anything narrower
    // than the built-in name list sends /quit to the agent as prose at
    // the exact moment the operator meant it most.
    it('still treats a slash command at a held session as a command', async () => {
      const { term, client, text } = mount({ features: { pause: true } });
      client.feed(paused());
      await flush();

      await term.submit('/help');
      expect(text()).toContain('This list');
      expect(client.calls.map((c) => c.name)).not.toContain('resume');

      // Including one this table does not know — it is still not prose.
      await term.submit('/quit');
      expect(text()).toContain('Unknown command: /quit');
      expect(client.calls.map((c) => c.name)).not.toContain('resume');
    });

    // "Stop and let me look" is worth nothing if it only works once the
    // thing you wanted to look at has finished.
    it('lets /pause through mid-turn, and nothing else', async () => {
      const { term, client } = mount({ features: { pause: true } });
      client.inject = async () => {};
      const pending = term.submit('do the thing');

      await term.submit('/usage');
      expect(client.calls.map((c) => c.name)).not.toContain('getUsage');

      await term.submit('/pause');
      expect(client.calls.map((c) => c.name)).toContain('pause');

      term.connection.getActiveTurn().finish({ totalMs: 1, tokens: { in: 0, out: 0 } });
      await pending;
    });

    // A backend that lists the `pause` event but whose agent has no
    // PauseController: the gate can close from elsewhere and this
    // operator has no way to open it. Say that, rather than offering a
    // button that 501s.
    it('offers no controls when the agent cannot resume', async () => {
      const { term, client, text, hold } = mount({ features: { pause: false } });
      client.feed(paused());
      await flush();
      expect(hold().hidden).toBe(false);
      expect(hold().textContent).toContain('no resume route');
      expect(hold().querySelector('.term-hold-go').hidden).toBe(true);

      await term.submit('/continue');
      expect(text()).toContain('/continue is not supported by this backend.');
      // And a typed steer, which reaches the resume path past both the
      // table's gate and the hidden buttons.
      await term.submit('never mind');
      expect(text()).toContain('no resume route');
      expect(client.calls.map((c) => c.name)).not.toContain('resume');
    });

    // The other half of the same gate. A pre-1.5.0 server has no
    // /pause route and no `pause` flag either, and an absent flag
    // reads as on — so without the version the three commands would be
    // offered to a backend that can only 404 at them.
    it('is not offered by a backend that predates the route', async () => {
      const { term, client, text } = mount({ protocol: '1.4.0' });
      await term.submit('/help');
      expect(text()).toContain('/pause, /continue, /abandon');
      await term.submit('/pause');
      expect(text()).toContain('/pause is not supported by this backend.');
      expect(client.calls).toEqual([]);
    });

    // resumed:false with a 200 is the idempotent answer from two
    // surfaces racing the same click, not a failure.
    it('reports a resume that found no hold, without claiming one', async () => {
      const { term, client, text } = mount({ features: { pause: true } });
      client.resume = async () => ({ resumed: false, mode: 'continue' });
      await term.submit('/continue');
      expect(text()).toContain('The session was not held.');
      expect(text()).not.toContain('Resumed');
    });

    it('surfaces a failed resume rather than lowering the banner', async () => {
      const { term, client, text, hold } = mount({ features: { pause: true } });
      client.feed(paused());
      await flush();
      client.resume = async () => {
        throw new Error('socket died');
      };
      await term.submit('/continue');
      expect(text()).toContain('Resume failed');
      expect(hold().hidden).toBe(false);
      expect(term.state.paused).toBe(true);
    });
  });

  // ─── /share (#91) ──────────────────────────────────────────────────
  //
  // The three things the ACL contract makes easy to get wrong, and
  // which are therefore what this block is about: the gate is the
  // protocol version and not a probe, a PATCH sends only the lists it
  // touched, and viewer and contributor are two grants rather than one
  // with a volume knob.
  describe('/share', () => {
    const lastPatch = (client) =>
      client.calls.filter((c) => c.name === 'patchACL').map((c) => c.args[0]);

    it('lists the owner and both grants, counted separately', async () => {
      const { term, text } = mount();
      await term.submit('/share');
      expect(text()).toContain('owner alice@example.com');
      expect(text()).toContain('Viewers (1)');
      expect(text()).toContain('bob@example.com');
      expect(text()).toContain('Contributors (0)');
      // An empty list is a fact, not an absence — renderList prints it.
      expect(text()).toContain('(none)');
    });

    it('marks the caller, so "owner" answers "is that me"', async () => {
      const { term, text } = mount();
      term.session.setWhoami({ identity: 'alice@example.com' });
      await term.submit('/share');
      expect(text()).toContain('owner alice@example.com (you)');
    });

    it('grants a viewer by sending only the list it touched', async () => {
      const { term, client, text } = mount();
      await term.submit('/share viewer carol@example.com');
      expect(lastPatch(client)).toEqual([{ viewers: ['bob@example.com', 'carol@example.com'] }]);
      // Contributors is absent rather than `[]`: this edit has nothing
      // to say about it, and `[]` would clear it.
      expect(Object.keys(lastPatch(client)[0])).toEqual(['viewers']);
      expect(text()).toContain('carol@example.com is now a viewer');
    });

    it('promotes rather than double-lists, and says both lists changed', async () => {
      const { term, client, text } = mount();
      await term.submit('/share contributor bob@example.com');
      expect(lastPatch(client)).toEqual([{ viewers: [], contributors: ['bob@example.com'] }]);
      expect(text()).toContain('Viewers (0)');
      expect(text()).toContain('Contributors (1)');
      expect(text()).toContain('bob@example.com is now a contributor');
    });

    it('renders what was stored, not what was sent', async () => {
      const { term, client, text } = mount();
      // A server that normalizes — here, by refusing to keep anybody at
      // all. Rendering the request would claim carol is a viewer.
      client.patchACL = async () => ({ owner: 'alice@example.com', viewers: [], contributors: [] });
      await term.submit('/share viewer carol@example.com');
      expect(text()).toContain('Viewers (0)');
      expect(text()).not.toContain('carol@example.com\n');
    });

    it('revokes from whichever list the identity was in', async () => {
      const { term, client, text } = mount();
      await term.submit('/share revoke bob@example.com');
      expect(lastPatch(client)).toEqual([{ viewers: [] }]);
      expect(text()).toContain('revoked bob@example.com');
    });

    it('does not spend a PATCH on a no-op', async () => {
      const { term, client, text } = mount();
      await term.submit('/share viewer bob@example.com');
      expect(text()).toContain('already a viewer');
      await term.submit('/share revoke nobody@example.com');
      expect(text()).toContain('was not on the ACL');
      expect(client.calls.map((c) => c.name)).not.toContain('patchACL');
    });

    // Transfer is not this endpoint's job, and neither is demoting the
    // owner to a viewer of their own session.
    it('refuses to grant or revoke the owner', async () => {
      const { term, client, text } = mount();
      await term.submit('/share viewer alice@example.com');
      expect(text()).toContain('cannot be demoted or removed');
      expect(client.calls.map((c) => c.name)).not.toContain('patchACL');
    });

    it('answers a missing or unknown argument with the usage', async () => {
      const { term, client, text } = mount();
      await term.submit('/share viewer');
      expect(text()).toContain('Who? /share viewer <identity>');
      await term.submit('/share admin carol@example.com');
      expect(text()).toContain('Unknown /share verb "admin"');
      expect(text()).toContain('/share revoke <identity> to take it back');
      expect(client.calls.map((c) => c.name)).not.toContain('getACL');
    });

    // The reason the command is version-gated: with the route's
    // existence already established, a 404 has one meaning left, and
    // it is not "this backend is old".
    it('reads a 404 as "not yours", because the version already ruled out "no route"', async () => {
      const { term, client, text } = mount();
      const gone = new Error('session not found');
      gone.status = 404;
      client.getACL = async () => {
        throw gone;
      };
      await term.submit('/share');
      expect(text()).toContain('Only the owner can see or change who a session is shared with');
      expect(text()).not.toContain('session not found');
    });

    it('reports any other failure as itself', async () => {
      const { term, client, text } = mount();
      client.getACL = async () => {
        throw new Error('socket died');
      };
      await term.submit('/share');
      expect(text()).toContain('/share failed: socket died');
    });

    // The version gate, from both ends: hidden in /help and refused by
    // name, with no request either way. A 1.7.0 daemon has no route.
    it('is absent from a pre-1.10.0 backend, and refuses without probing', async () => {
      const { term, client, text } = mount({ protocol: '1.7.0' });
      await term.submit('/help');
      expect(text()).toContain('Not supported by this backend: /share');
      expect(text()).not.toContain('Who else may reach this session');

      await term.submit('/share');
      expect(text()).toContain('/share is not supported by this backend.');
      expect(client.calls).toEqual([]);
    });

    it('is offered by a 1.10.0 backend, which is the version that has it', async () => {
      const { term, text } = mount({ protocol: '1.10.0' });
      await term.submit('/help');
      expect(text()).toContain('/share');
      expect(text()).not.toContain('Not supported by this backend');
    });
  });

  // #93, spec v1.12.0. Until now "running" meant "this browser pressed
  // send": a mid-turn GET /status answered `idle` because the run loop
  // had no signal to read, so a session another operator was driving
  // looked idle in every surface we draw. The tests below are about the
  // two halves staying apart — what the server says is executing, and
  // what we dispatched — because the surfaces want different ones.
  describe('status truth', () => {
    // Replaces the stub's recorded getStatus with a counted one, so a
    // test can watch the chain without the reply changing under it.
    function polling(client, body) {
      const seen = { count: 0, body: body || { state: 'idle' } };
      client.getStatus = async () => {
        seen.count += 1;
        return seen.body;
      };
      return seen;
    }

    const inflight = (term) => term.el.querySelector('.term-inflight');

    it('asks once the stream attaches, because no frame will say this', async () => {
      const { term, client } = mount();
      const seen = polling(client, { state: 'running', turn_in_flight: true });
      client.conn('connected');
      await flush();
      expect(seen.count).toBe(1);
      // Running, and not by us: the pair the seam keeps unfolded.
      expect(term.state.running).toBe(true);
      expect(term.state.driving).toBe(false);
      expect(term.state.turnInFlight).toBe(true);
      expect(term.state.runState).toBe('running');
      expect(inflight(term).hidden).toBe(false);
    });

    // The version gate and the start of the chain are the same moment,
    // and it is not the socket opening: 'connected' fires on the open
    // and the capabilities frame is the first thing to arrive on it, so
    // a client asked at connect does not yet know what it is talking
    // to. Getting this wrong arms nothing and the poll silently never
    // happens — which is exactly how it first shipped.
    it('starts the chain when the version lands, not when the socket opens', async () => {
      const { client } = mount();
      const seen = polling(client);
      let known = false;
      client.protocolAtLeast = () => known;

      client.conn('connected');
      await flush();
      expect(seen.count).toBe(0);

      known = true;
      client.feed({ type: 'capabilities', data: { protocol_version: '1.12.0' } });
      await flush();
      expect(seen.count).toBe(1);
    });

    // The negotiated version, not the capabilities frame: a 1.11.0
    // daemon serves the route and answers 'idle' to every read of it,
    // which is a request per panel per ten seconds for no fact.
    it('does not poll a backend that cannot produce the answer', async () => {
      const { client } = mount();
      const seen = polling(client);
      client.protocolAtLeast = () => false;
      client.conn('connected');
      await flush();
      expect(seen.count).toBe(0);
    });

    it('stops asking when the stream drops, and when the panel closes', async () => {
      vi.useFakeTimers();
      try {
        const { term, client } = mount();
        const seen = polling(client);
        client.conn('connected');
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.count).toBe(1);

        client.conn('disconnected');
        await vi.advanceTimersByTimeAsync(60000);
        expect(seen.count).toBe(1);

        client.conn('connected');
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.count).toBe(2);
        term.destroy();
        await vi.advanceTimersByTimeAsync(60000);
        expect(seen.count).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    // Two cadences, and which one is running is recomputed from the
    // state at each tick rather than fixed when the chain was armed.
    it('slows down when nothing is moving and speeds up when it is', async () => {
      vi.useFakeTimers();
      try {
        const { term, client } = mount({ features: { pause: true } });
        const seen = polling(client);
        client.conn('connected');
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.count).toBe(1);

        await vi.advanceTimersByTimeAsync(9000);
        expect(seen.count).toBe(1);
        await vi.advanceTimersByTimeAsync(1500);
        expect(seen.count).toBe(2);

        // Held with a turn behind the gate — the one window where the
        // answer is changing and somebody is waiting on it.
        seen.body = { state: 'paused', paused: true, turn_in_flight: true };
        await vi.advanceTimersByTimeAsync(10000);
        const settled = seen.count;
        await vi.advanceTimersByTimeAsync(3500);
        expect(seen.count).toBe(settled + 1);
        expect(term.state.paused).toBe(true);
        // Held is not a claim that nothing is running; that is the
        // whole reason the bool exists beside `state`.
        expect(term.state.running).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // A caller that asks early replaces the wait rather than adding to
    // it. Two chains would double every panel's traffic and there is
    // nothing in the UI that would show it.
    it('keeps one chain when something asks for a read mid-wait', async () => {
      vi.useFakeTimers();
      try {
        const { term, client } = mount({ features: { pause: true } });
        const seen = polling(client);
        client.conn('connected');
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.count).toBe(1);

        await vi.advanceTimersByTimeAsync(2000);
        await term.refreshStatus();
        expect(seen.count).toBe(2);

        // The original ten-second timer, had it survived, would fire in
        // here on top of the new one.
        await vi.advanceTimersByTimeAsync(9000);
        expect(seen.count).toBe(2);
        await vi.advanceTimersByTimeAsync(1500);
        expect(seen.count).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('says nothing in the transcript when a poll fails, and keeps asking', async () => {
      vi.useFakeTimers();
      try {
        const { client, text } = mount();
        let count = 0;
        client.getStatus = async () => {
          count += 1;
          throw new Error('status unavailable');
        };
        client.conn('connected');
        await vi.advanceTimersByTimeAsync(0);
        expect(count).toBe(1);
        expect(text()).not.toContain('status unavailable');
        await vi.advanceTimersByTimeAsync(10500);
        expect(count).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    // The fast half of the pair. The broadcaster folds turn_in_flight
    // into turn_state:'streaming' before the frame leaves, so a
    // streaming frame is the server saying a turn is executing — and it
    // arrives whoever started it.
    it('counts a streaming status-update as running, whoever started it', async () => {
      const { term, client } = mount();
      client.feed({ type: 'status-update', data: { turn_state: 'streaming' } });
      expect(term.state.turnState).toBe('streaming');
      expect(term.state.running).toBe(true);
      expect(term.state.driving).toBe(false);
      expect(inflight(term).hidden).toBe(false);

      client.feed({ type: 'status-update', data: { turn_state: 'idle' } });
      expect(term.state.running).toBe(false);
      expect(inflight(term).hidden).toBe(true);
    });

    // Not every producer retracts it. The 001 conformance capture is a
    // status-update saying 'streaming' and then a turn-complete, with
    // nothing after — and a panel that believed the last frame it was
    // given would claim to be working for the rest of the session.
    it('lets turn-complete end a turn no status-update came back to close', async () => {
      const { term, client } = mount();
      client.feed({ type: 'status-update', data: { turn_state: 'streaming' } });
      expect(term.state.running).toBe(true);

      client.feed({ type: 'turn-complete', data: { latency_ms: 120 } });
      expect(term.state.turnState).toBe('idle');
      expect(term.state.running).toBe(false);
      expect(inflight(term).hidden).toBe(true);
    });

    // The footer slot is for the turn you did not start. When you did,
    // the elapsed timer beside it already says so, at a resolution this
    // could not match.
    it('withholds the footer slot while this browser is the one driving', async () => {
      const { term, client } = mount();
      polling(client, { state: 'running', turn_in_flight: true });
      term.connection.setIsRunning(true);
      await term.refreshStatus();
      expect(term.state.running).toBe(true);
      expect(term.state.driving).toBe(true);
      expect(inflight(term).hidden).toBe(true);

      term.connection.setIsRunning(false);
      await term.refreshStatus();
      expect(inflight(term).hidden).toBe(false);
    });

    // Absent is not false, twice over: a 1.11.0 daemon sends neither
    // key and a 1.12.0 daemon omits both when nothing is running. What
    // it must never do is veto a turn this browser can see itself.
    it('does not let a silent poll contradict a turn we dispatched', async () => {
      const { term, client } = mount();
      polling(client, { state: 'idle' });
      term.connection.setIsRunning(true);
      await term.refreshStatus();
      expect(term.state.runState).toBe('idle');
      expect(term.state.turnInFlight).toBe(false);
      expect(term.state.running).toBe(true);
    });
  });

  // #94: absence means unknown, never none. Three reads that share
  // nothing but that rule — who approved a tool call, what a
  // specialist was granted, and whether a stop stopped anything.
  describe('absence means unknown', () => {
    describe('/perms', () => {
      it('renders the log and names who approved what', async () => {
        const { term, text } = mount();
        await term.submit('/perms');
        expect(text()).toContain('Permissions — mode ask');
        expect(text()).toContain('bash_exec git push');
        expect(text()).toContain('by ada@example.com');
      });

      // The row the daemon could not attribute. It says so; it does
      // not borrow the identity of whoever is reading.
      it('says unattributed for a row with no verified approver', async () => {
        const { term, text } = mount();
        await term.submit('/perms');
        expect(text()).toContain('unattributed');
        expect(text()).not.toContain('by alice@example.com');
      });

      // On a pre-1.10.0 backend every row would read "unattributed"
      // and mean nothing. Say it once, about the backend.
      it('drops per-row attribution on a backend that cannot attribute', async () => {
        const { term, client, text } = mount();
        client.protocolAtLeast = (v) => v !== '1.10.0';
        await term.submit('/perms');
        expect(text()).toContain('does not attribute approvals');
        expect(text()).not.toContain('unattributed');
        expect(text()).not.toContain('by ada@example.com');
      });

      it('reports a failed read rather than an empty log', async () => {
        const { term, client, text } = mount();
        client.getPerms = async () => {
          throw new Error('HTTP 501: no PermsProvider');
        };
        await term.submit('/perms');
        expect(text()).toContain('/perms failed');
      });
    });

    describe('/specialists', () => {
      it('summarizes the grant each specialist reports', async () => {
        const { term, text } = mount();
        await term.submit('/specialists');
        expect(text()).toContain('Specialists (2)');
        expect(text()).toContain('builtin 1');
      });

      // The missing key, which a 1.9.0 daemon sends for a specialist
      // with no grant of its own and every older one sends for all of
      // them.
      it('reports a specialist with no reported grant as unknown', async () => {
        const { term, text } = mount();
        await term.submit('/specialists');
        expect(text()).toContain('grant unknown');
        expect(text()).not.toContain('no tools of its own');
      });

      it('drills into one specialist’s grant, grouped by source', async () => {
        const { term, text } = mount();
        await term.submit('/specialists researcher');
        expect(text()).toContain('researcher — m-1 · sync/async');
        expect(text()).toContain('Read files');
      });
    });

    describe('/subagents stop', () => {
      it('says this call is what stopped it', async () => {
        const { term, client, text } = mount();
        await term.submit('/subagents stop researcher');
        expect(client.calls.at(-1)).toEqual({ name: 'stopSubagent', args: ['researcher'] });
        expect(text()).toContain('Stopped subagent "researcher"');
        expect(text()).toContain('ended as "stopped"');
      });

      // The case #897 was filed about. Through 1.11.0 this answered
      // `stopped: true` and the operator was told they had stopped
      // something that finished thirty seconds earlier.
      it('says so when the subagent had already finished', async () => {
        const { term, client, text } = mount();
        client.stopSubagent = async () => ({
          session: 's1',
          agent: 'implementer',
          stopped: false,
          status: 'completed',
        });
        await term.submit('/subagents stop implementer');
        expect(text()).toContain('had already finished before the stop arrived');
        expect(text()).toContain('ended as "completed"');
        expect(text()).not.toContain('Stopped subagent');
      });

      // A pre-1.12.0 daemon cannot tell the two apart, so neither do
      // we: the 200 still means "it is not running now", and that is
      // the only claim left worth making.
      it('claims only the post-condition on a backend that cannot tell', async () => {
        const { term, client, text } = mount();
        client.protocolAtLeast = (v) => v !== '1.12.0';
        client.stopSubagent = async () => ({ session: 's1', agent: 'researcher', stopped: true });
        await term.submit('/subagents stop researcher');
        expect(text()).toContain('is no longer running');
        expect(text()).not.toContain('Stopped subagent');
      });

      it('surfaces a 404 as the miss it is', async () => {
        const { term, client, text } = mount();
        client.stopSubagent = async () => {
          throw new Error('POST /agents/ghost/stop → HTTP 404: no subagent named "ghost"');
        };
        await term.submit('/subagents stop ghost');
        expect(text()).toContain('/subagents stop ghost failed');
      });

      it('asks for a name rather than stopping something at random', async () => {
        const { term, client, text } = mount();
        await term.submit('/subagents stop');
        expect(text()).toContain('Usage: /subagents stop <name>');
        expect(client.calls).toEqual([]);
      });
    });

    // The inline card, where the same question is asked about the
    // click that just happened. Reaching it means opening the prompt
    // stream, which is the terminal's second EventSource — stubbed
    // here, since jsdom has no real one and the frame is what matters.
    describe('the permission card', () => {
      async function prompted(over) {
        const { term, client, text } = mount();
        globalThis.EventSource = class {
          addEventListener() {}
          close() {}
        };
        client.connect = async () => {};
        client.autoSelectSession = async () => ({ id: 's1' });
        load('attach-core/prompter.js');
        await term.connect();
        const pr = term.connection.getPrompter();
        pr.respond = async () => over;
        pr.onPrompt({ id: 'perms-1', kind: 'bash', tool: 'bash_exec', detail: 'rm -rf ./build' });
        const card = term.el.querySelector('.perms-request');
        return { term, client, text, card };
      }

      const allowOnce = (card) =>
        [...card.querySelectorAll('button')].find((b) => b.textContent === 'ALLOW ONCE');

      it('records who the daemon attributed the decision to', async () => {
        const { card } = await prompted({ acknowledged: true, approver: 'ada@example.com' });
        allowOnce(card).click();
        await flush();
        expect(card.querySelector('.perms-outcome').textContent).toBe('allow-once');
        expect(card.querySelector('.perms-approver').textContent).toBe('by ada@example.com');
      });

      // Worth saying at the moment of clicking rather than during the
      // review that goes looking: this decision lands in the log with
      // nobody's name on it.
      it('says unattributed when the daemon verified nobody', async () => {
        const { card } = await prompted({ acknowledged: true });
        allowOnce(card).click();
        await flush();
        expect(card.querySelector('.perms-approver').textContent).toBe('unattributed');
      });

      // Never the current user. `whoami` is one call away and it would
      // be the wrong answer on any session with two people in it.
      it('does not fill the blank in with this browser’s identity', async () => {
        const { term, card } = await prompted({ acknowledged: true });
        await term.submit('/whoami');
        allowOnce(card).click();
        await flush();
        expect(card.querySelector('.perms-approver').textContent).not.toContain('alice');
      });

      it('adds nothing on a backend with no attribution to give', async () => {
        const { client, card } = await prompted({});
        client.protocolAtLeast = (v) => v !== '1.10.0';
        allowOnce(card).click();
        await flush();
        expect(card.querySelector('.perms-approver')).toBeNull();
      });
    });
  });
});
