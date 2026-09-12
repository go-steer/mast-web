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
    listConfiguredSubagents: record('listConfiguredSubagents', [
      { name: 'researcher', description: 'Research', model: 'm-1', modes: ['sync', 'async'] },
    ]),
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
    _post: record('_post', { _render: 'text', body: 'ok' }),
    disconnect() {},
  };
}

function mount({ features, slashCommands, commands } = {}) {
  const client = stubClient();
  globalThis.AttachClient = function () {
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
    features: features,
    slash_commands: slashCommands || [],
  });
  return { term, client, text: () => term.out.textContent };
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
});
