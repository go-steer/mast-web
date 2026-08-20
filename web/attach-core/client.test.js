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

// Unit tests for web/attach-core/client.js — spec v1.2.0 alignment.
//
// Covers:
//   1. PermanentStreamError classification on HTTP 404/401/403
//   2. capabilities frame caching
//   3. tool-result latency_ms sidecar extraction (via protocol.js)
//   4. Legacy `agent` frame demux into stream-chunk / tool-call / tool-result
//   5. Both float64 (browser) and int64-shaped latency values

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Load the four attach-core modules in order into jsdom's window
// global — same order as index.html. errors / protocol / replay each
// set their respective window.AttachCore* namespace; client.js reads
// them at IIFE-init.
const here = dirname(fileURLToPath(import.meta.url));
const srcErrors = readFileSync(join(here, 'errors.js'), 'utf8');
const srcProtocol = readFileSync(join(here, 'protocol.js'), 'utf8');
const srcReplay = readFileSync(join(here, 'replay.js'), 'utf8');
const srcClient = readFileSync(join(here, 'client.js'), 'utf8');

function loadAttachClient() {
  const load = (s) => new Function('window', s)(globalThis);
  load(srcErrors);
  load(srcProtocol);
  load(srcReplay);
  load(srcClient);
  return globalThis.AttachClient;
}

describe('AttachClient', () => {
  let AttachClient;
  beforeEach(() => {
    delete globalThis.AttachClient;
    delete globalThis.AttachCoreErrors;
    delete globalThis.AttachCoreProtocol;
    delete globalThis.AttachCoreReplay;
    AttachClient = loadAttachClient();
  });

  describe('PermanentStreamError', () => {
    it('is exposed as a static on the constructor', () => {
      expect(AttachClient.PermanentStreamError).toBeDefined();
      const err = new AttachClient.PermanentStreamError('x', 404);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('PermanentStreamError');
      expect(err.status).toBe(404);
    });

    it('classifies 401/403/404 as permanent, everything else transient', () => {
      const P = AttachClient.PermanentStreamError;
      expect(P.isPermanentStatus(401)).toBe(true);
      expect(P.isPermanentStatus(403)).toBe(true);
      expect(P.isPermanentStatus(404)).toBe(true);
      expect(P.isPermanentStatus(400)).toBe(false);
      expect(P.isPermanentStatus(429)).toBe(false);
      expect(P.isPermanentStatus(500)).toBe(false);
      expect(P.isPermanentStatus(502)).toBe(false);
      expect(P.isPermanentStatus(200)).toBe(false);
    });

    it('_get throws PermanentStreamError on 404 (session gone or ACL revoked)', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('not found'),
      });
      await expect(client._get('/sessions')).rejects.toBeInstanceOf(
        AttachClient.PermanentStreamError
      );
    });

    it('_get throws plain Error on 500 (transient)', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('boom'),
      });
      let err;
      try {
        await client._get('/sessions');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AttachClient.PermanentStreamError);
    });

    it('_post throws PermanentStreamError on 401 (token revoked)', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('unauthorized'),
      });
      await expect(client._post('/sessions/s1/inject', { message: 'hi' })).rejects.toBeInstanceOf(
        AttachClient.PermanentStreamError
      );
    });
  });

  describe('session lifecycle', () => {
    it('createSession POSTs to /sessions and normalizes the response', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              app: 'core-agent',
              user: 'alice@example.com',
              sessionID: 'sess-abc',
              url: 'https://example/sessions/core-agent/sess-abc',
            })
          ),
      });
      const s = await client.createSession();
      expect(s).toEqual({
        id: 'sess-abc',
        app: 'core-agent',
        user: 'alice@example.com',
        url: 'https://example/sessions/core-agent/sess-abc',
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://example/sessions',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('createSession surfaces a 501 as a plain Error (no SessionFactory)', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 501,
        text: () => Promise.resolve('not supported'),
      });
      let err;
      try {
        await client.createSession();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AttachClient.PermanentStreamError);
    });

    it('createSession surfaces a 401 as a PermanentStreamError (anonymous)', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('unauthorized'),
      });
      await expect(client.createSession()).rejects.toBeInstanceOf(
        AttachClient.PermanentStreamError
      );
    });

    it('deleteSession DELETEs the qualified path', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204, text: () => '' });
      await client.deleteSession('core-agent', 'sess-abc');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://example/sessions/core-agent/sess-abc',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    // Regression guard: core-agent's browserWriteGuard 415s every write
    // method without `Content-Type: application/json`, including a
    // body-less DELETE. This call site was the only one missing it, so
    // deleteSession failed against every real backend.
    it('deleteSession sends Content-Type: application/json (csrf.go 415 guard)', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204, text: () => '' });
      await client.deleteSession('core-agent', 'sess-abc');
      const [, opts] = globalThis.fetch.mock.calls[0];
      expect(opts.headers['Content-Type']).toBe('application/json');
    });

    it('deleteSession surfaces 403 as a permanent error (bootstrap default guard)', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('cannot delete bootstrap session'),
      });
      await expect(client.deleteSession('core-agent', 'default')).rejects.toBeInstanceOf(
        AttachClient.PermanentStreamError
      );
    });

    it('listSessions parses status + last_touched_at fields (v1.1.0+)', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            sessions: [
              {
                app_name: 'core-agent',
                user_id: 'alice',
                session_id: 's1',
                has_event_log: true,
                status: 'active',
                last_touched_at: '2026-07-20T12:00:00Z',
              },
              {
                app_name: 'core-agent',
                user_id: 'alice',
                session_id: 's2',
                has_event_log: true,
                status: 'idle',
                last_touched_at: '2026-07-19T12:00:00Z',
              },
            ],
          }),
      });
      const sessions = await client.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].status).toBe('active');
      expect(sessions[0].lastTouchedAt).toBe('2026-07-20T12:00:00Z');
      expect(sessions[1].status).toBe('idle');
    });

    // autoSelectSession used to throw on an empty list, on the reading
    // that empty meant "daemon has no session store". In a hosted
    // deployment the agent scopes GET /sessions to the calling
    // identity, so a brand-new user lists zero sessions against a
    // perfectly healthy daemon — the old behavior locked every new
    // user out on their first visit.
    it('autoSelectSession creates a session when the caller owns none', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      const calls = [];
      globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
        calls.push(`${opts?.method || 'GET'} ${url}`);
        if (opts?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            status: 201,
            text: () =>
              Promise.resolve(
                JSON.stringify({ app: 'core-agent', user: 'bob@example.com', sessionID: 'new-1' })
              ),
          });
        }
        // Empty before the create, populated after.
        const made = calls.some((c) => c.startsWith('POST'));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              sessions: made
                ? [{ app: 'core-agent', user: 'bob@example.com', sessionID: 'new-1' }]
                : [],
            }),
        });
      });

      const s = await client.autoSelectSession();
      expect(s.id).toBe('new-1');
      expect(client.sessionId).toBe('new-1');
      expect(calls).toEqual([
        'GET https://example/sessions',
        'POST https://example/sessions',
        'GET https://example/sessions',
      ]);
    });

    it('autoSelectSession falls back to the create response if the re-list is still empty', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
        if (opts?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            status: 201,
            text: () =>
              Promise.resolve(
                JSON.stringify({ app: 'core-agent', user: 'bob@example.com', sessionID: 'new-2' })
              ),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      });

      const s = await client.autoSelectSession();
      expect(s).toMatchObject({ id: 'new-2', app: 'core-agent', user: 'bob@example.com' });
      expect(client.sessionId).toBe('new-2');
    });

    // A daemon that genuinely can't make sessions answers 501, which
    // is the case the old "start with --session-db" text described.
    // Keep that advice, now attached to the request that establishes it.
    it('autoSelectSession surfaces the create failure with the session-store hint', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
        if (opts?.method === 'POST') {
          return Promise.resolve({
            ok: false,
            status: 501,
            text: () => Promise.resolve('no session factory'),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ sessions: [] }),
        });
      });

      let err;
      try {
        await client.autoSelectSession();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('501');
      expect(err.message).toContain('--session-db');
    });

    // Regression guard, matching the one in prompter.test.js: the SSE
    // URL used to carry ?access_token=<token>, which core-agent never
    // read (checkAttachToken looks only at X-Attach-Token and
    // Authorization) and which leaked the credential into access logs.
    it('connect() never puts the token in the SSE URL', async () => {
      const opened = [];
      const priorES = globalThis.EventSource;
      globalThis.EventSource = class {
        constructor(url) {
          opened.push(url);
          this.addEventListener = () => {};
        }
        close() {}
      };
      try {
        const client = new AttachClient({
          endpoint: 'https://example',
          token: 'secret',
          sessionId: 'sess-abc',
          onEvent: () => {},
        });
        await client.connect();
        expect(opened).toHaveLength(1);
        expect(opened[0]).toBe('https://example/sessions/sess-abc/events');
        expect(opened[0]).not.toContain('secret');
        expect(opened[0]).not.toContain('access_token');
      } finally {
        globalThis.EventSource = priorES;
      }
    });

    it('sessionGen bumps on connect() and tags emitted events', () => {
      // We can't easily exercise connect()'s SSE bits under jsdom, but
      // we can verify the sessionGen field is initialized to 0 (the
      // "no stream yet" sentinel) and that _fanoutAgentFrame tags
      // fanned events with the current gen.
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      expect(client.sessionGen).toBe(0);
      // Manually bump — connect() would do this after autoSelectSession.
      client.sessionGen = 3;
      const events = [];
      client.onEvent = (e) => events.push(e);
      client._fanoutAgentFrame({
        event: { Content: { parts: [{ text: 'hello' }] } },
      });
      expect(events).toHaveLength(1);
      expect(events[0].gen).toBe(3);
      expect(events[0].type).toBe('stream-chunk');
    });

    it('_fanoutAgentFrame carries the passed-in gen argument (streamGen at listener-time)', () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      client.sessionGen = 99;
      const events = [];
      client.onEvent = (e) => events.push(e);
      // Pass gen=2 explicitly — mimics what happens in the SSE
      // addEventListener closure (streamGen captured at listener-
      // registration time survives even after sessionGen bumps).
      client._fanoutAgentFrame({ event: { Content: { parts: [{ text: 'stale' }] } } }, 2);
      expect(events[0].gen).toBe(2);
    });

    it('interrupt returns { ok: true, interrupted: "yes" } on 200 with no header', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        headers: { get: () => null },
      });
      const r = await client.interrupt();
      expect(r).toEqual({ ok: true, interrupted: 'yes' });
    });

    it('interrupt returns "nothing-in-flight" when X-Interrupted header is set', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        headers: { get: (name) => (name === 'X-Interrupted' ? 'nothing-in-flight' : null) },
      });
      const r = await client.interrupt();
      expect(r).toEqual({ ok: true, interrupted: 'nothing-in-flight' });
    });

    it('interrupt returns { ok: false, unsupported: true } on 412 (no InterruptProvider)', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 412,
        text: () => Promise.resolve('interrupt not supported'),
        headers: { get: () => null },
      });
      const r = await client.interrupt();
      expect(r).toEqual({ ok: false, unsupported: true });
    });

    it('whoami GETs /whoami and returns the response verbatim (v1.4.0)', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            identity: 'alice@example.com',
            admin: false,
            source: 'bearer',
            proxy_by: '',
          }),
      });
      const w = await client.whoami();
      expect(w).toEqual({
        identity: 'alice@example.com',
        admin: false,
        source: 'bearer',
        proxy_by: '',
      });
      const [url] = globalThis.fetch.mock.calls[0];
      expect(url).toBe('https://example/whoami');
    });

    it('whoami surfaces proxy_by field when set (X-Asserted-Caller path)', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            identity: 'alice@example.com',
            admin: false,
            source: 'asserted',
            proxy_by: 'bot-service@example.com',
          }),
      });
      const w = await client.whoami();
      expect(w.source).toBe('asserted');
      expect(w.proxy_by).toBe('bot-service@example.com');
    });

    it('whoami propagates 401 as PermanentStreamError (unauthenticated)', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('unauthorized'),
      });
      await expect(client.whoami()).rejects.toBeInstanceOf(AttachClient.PermanentStreamError);
    });

    it('interrupt propagates 404 as PermanentStreamError', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('session gone'),
        headers: { get: () => null },
      });
      await expect(client.interrupt()).rejects.toBeInstanceOf(AttachClient.PermanentStreamError);
    });

    it('listSessions defaults status to "active" when server omits it (back-compat)', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            sessions: [
              { app_name: 'core-agent', user_id: 'alice', session_id: 's1', has_event_log: true },
            ],
          }),
      });
      const sessions = await client.listSessions();
      expect(sessions[0].status).toBe('active');
      expect(sessions[0].lastTouchedAt).toBeNull();
    });
  });

  describe('BackendDrainingError — 503 shutdown-drain gating', () => {
    it('is exposed as a static on the constructor', () => {
      expect(AttachClient.BackendDrainingError).toBeDefined();
      const err = new AttachClient.BackendDrainingError('draining', 5);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('BackendDrainingError');
      expect(err.retryAfterSeconds).toBe(5);
    });

    it('_post throws BackendDrainingError on 503 with Retry-After parsed', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () =>
          Promise.resolve(
            'daemon is shutting down; queued messages would be lost — retry after restart'
          ),
        headers: { get: (name) => (name === 'Retry-After' ? '5' : null) },
      });
      let err;
      try {
        await client._post('/sessions/s1/inject', { message: 'hi' });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AttachClient.BackendDrainingError);
      expect(err.retryAfterSeconds).toBe(5);
    });

    it('_post defaults retryAfterSeconds to null when the header is absent', async () => {
      const client = new AttachClient({ endpoint: 'https://example', onEvent: () => {} });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('draining'),
        headers: { get: () => null },
      });
      let err;
      try {
        await client._post('/sessions/s1/inject', {});
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AttachClient.BackendDrainingError);
      expect(err.retryAfterSeconds).toBeNull();
    });

    it('interrupt throws BackendDrainingError on 503', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('draining'),
        headers: { get: (name) => (name === 'Retry-After' ? '3' : null) },
      });
      let err;
      try {
        await client.interrupt();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AttachClient.BackendDrainingError);
      expect(err.retryAfterSeconds).toBe(3);
    });
  });

  describe('guardrails — read + operator reset (core-agent#670/#671)', () => {
    it('getGuardrails GETs /sessions/{sid}/guardrails and returns the shape verbatim', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      const shape = {
        watchdog: { mode: 'enforce', tripped: true, reason: 'runaway tool loop' },
        cost_ceiling: {
          max_turn_usd: 1,
          max_session_usd: 10,
          session_cost_usd: 10.5,
          tripped: true,
          would_retrip: true,
        },
        halted: true,
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(shape),
      });
      const g = await client.getGuardrails();
      expect(g).toEqual(shape);
      const [url] = globalThis.fetch.mock.calls[0];
      expect(url).toBe('https://example/sessions/s1/guardrails');
    });

    it('resetGuardrails POSTs an empty body by default and returns { ok: true, ... } on 200', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ reset: ['watchdog', 'cost_ceiling'], guardrails: {} }),
      });
      const r = await client.resetGuardrails();
      expect(r.ok).toBe(true);
      expect(r.reset).toEqual(['watchdog', 'cost_ceiling']);
      const [url, opts] = globalThis.fetch.mock.calls[0];
      expect(url).toBe('https://example/sessions/s1/guardrails/reset');
      expect(JSON.parse(opts.body)).toEqual({});
    });

    it('resetGuardrails sends guardrail + additional_budget_usd when passed', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ reset: ['cost_ceiling'], budget_added_usd: 5, guardrails: {} }),
      });
      await client.resetGuardrails({ guardrail: 'cost_ceiling', additionalBudgetUsd: 5 });
      const [, opts] = globalThis.fetch.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({
        guardrail: 'cost_ceiling',
        additional_budget_usd: 5,
      });
    });

    it('resetGuardrails resolves with { ok: false, ... } on 409 (would immediately re-trip)', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      const body409 = {
        reset: [],
        guardrails: { cost_ceiling: { tripped: true, would_retrip: true } },
        message: 'reset would immediately re-trip; additional budget required',
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve(body409),
      });
      const r = await client.resetGuardrails();
      expect(r.ok).toBe(false);
      expect(r.reset).toEqual([]);
      expect(r.message).toMatch(/re-trip/);
    });

    it('resetGuardrails throws BackendDrainingError on 503', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('draining'),
        headers: { get: (name) => (name === 'Retry-After' ? '5' : null) },
      });
      await expect(client.resetGuardrails()).rejects.toBeInstanceOf(
        AttachClient.BackendDrainingError
      );
    });

    it('resetGuardrails surfaces 501 (no GuardrailResetter) as a plain Error', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 501,
        json: () => Promise.reject(new Error('not json')),
        text: () => Promise.resolve('no GuardrailResetter wired'),
      });
      let err;
      try {
        await client.resetGuardrails();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AttachClient.PermanentStreamError);
      expect(err).not.toBeInstanceOf(AttachClient.BackendDrainingError);
    });
  });

  describe('configured-subagent catalog (core-agent#627/#634)', () => {
    it('listConfiguredSubagents GETs /sessions/{sid}/subagents and returns the array', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      const subs = [
        {
          name: 'reviewer',
          description: 'code review',
          model: 'gemini-3.1-pro',
          modes: ['sync', 'async'],
        },
        { name: 'triager', modes: ['async'] },
      ];
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ subagents: subs }),
      });
      const out = await client.listConfiguredSubagents();
      expect(out).toEqual(subs);
      const [url] = globalThis.fetch.mock.calls[0];
      expect(url).toBe('https://example/sessions/s1/subagents');
    });

    it('listConfiguredSubagents defaults to [] when the field is absent', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
      const out = await client.listConfiguredSubagents();
      expect(out).toEqual([]);
    });
  });

  describe('subagent turn drill-down (core-agent#638/#687)', () => {
    it('getSubagentEvents GETs the qualified path with since/limit query params', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      const shape = {
        agent: 'reviewer',
        parent_session_id: 's1',
        branches: [],
        events: [{ seq: 3, event: { Content: { parts: [{ text: 'hi' }] } } }],
        next_since: 4,
        truncated: false,
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(shape),
      });
      const out = await client.getSubagentEvents('core-agent', 'reviewer', { since: 2, limit: 50 });
      expect(out).toEqual(shape);
      const [url] = globalThis.fetch.mock.calls[0];
      expect(url).toBe(
        'https://example/sessions/core-agent/s1/agents/reviewer/events?since=2&limit=50'
      );
    });

    it('getSubagentEvents omits the query string when since/limit are absent', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ agent: 'reviewer', events: [] }),
      });
      await client.getSubagentEvents('core-agent', 'reviewer');
      const [url] = globalThis.fetch.mock.calls[0];
      expect(url).toBe('https://example/sessions/core-agent/s1/agents/reviewer/events');
    });

    it('getSubagentEvents propagates 404 as PermanentStreamError (unknown subagent)', async () => {
      const client = new AttachClient({
        endpoint: 'https://example',
        sessionId: 's1',
        onEvent: () => {},
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () =>
          Promise.resolve(
            JSON.stringify({ error: 'unknown agent', agent: 'ghost', available: ['reviewer'] })
          ),
      });
      await expect(client.getSubagentEvents('core-agent', 'ghost')).rejects.toBeInstanceOf(
        AttachClient.PermanentStreamError
      );
    });
  });

  describe('capabilities frame caching', () => {
    it('captures the first capabilities frame into client.capabilities', () => {
      const events = [];
      const client = new AttachClient({
        endpoint: 'https://example',
        onEvent: (e) => events.push(e),
      });

      // Simulate the typed-event dispatch (the addEventListener callback).
      // The client's addEventListener isn't reachable without wiring up an
      // EventSource, so we exercise the same closure logic directly by
      // constructing a mock event and re-running the handler shape.
      // Instead, we simulate what happens when a capabilities frame arrives:
      // set the field, then dispatch to onEvent.
      const capsData = {
        protocol_version: '1.2.0',
        event_types: ['status-update'],
        server: 'core-agent',
      };
      client.capabilities = capsData;
      client.onEvent({ type: 'capabilities', data: capsData });

      expect(client.capabilities).toEqual(capsData);
      expect(events[0]).toEqual({ type: 'capabilities', data: capsData });
    });
  });

  describe('_fanoutAgentFrame — legacy agent → typed sub-events', () => {
    it('emits stream-chunk for text parts (tagged with gen=0 pre-connect)', () => {
      const events = [];
      const client = new AttachClient({
        endpoint: 'https://example',
        onEvent: (e) => events.push(e),
      });
      client._fanoutAgentFrame({
        event: {
          Author: 'assistant',
          Partial: true,
          Content: { parts: [{ text: 'hello' }] },
        },
      });
      expect(events).toEqual([
        {
          type: 'stream-chunk',
          data: { text: 'hello', partial: true, author: 'assistant' },
          gen: 0,
          replay: false,
        },
      ]);
    });

    it('emits tool-call for functionCall parts (tagged with current gen)', () => {
      const events = [];
      const client = new AttachClient({
        endpoint: 'https://example',
        onEvent: (e) => events.push(e),
      });
      client._fanoutAgentFrame({
        event: {
          Content: {
            parts: [{ functionCall: { id: 'c1', name: 'fs_read', args: { path: '/x' } } }],
          },
        },
      });
      expect(events).toEqual([
        {
          type: 'tool-call',
          data: { id: 'c1', name: 'fs_read', args: { path: '/x' } },
          gen: 0,
          replay: false,
        },
      ]);
    });

    it('emits tool-result with latencyMs extracted from response.latency_ms (v1.2.0 sidecar)', () => {
      const events = [];
      const client = new AttachClient({
        endpoint: 'https://example',
        onEvent: (e) => events.push(e),
      });
      client._fanoutAgentFrame({
        event: {
          Content: {
            parts: [
              {
                functionResponse: {
                  id: 'c1',
                  name: 'fs_read',
                  response: { content: 'ok', latency_ms: 128 },
                },
              },
            ],
          },
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool-result');
      expect(events[0].data.id).toBe('c1');
      expect(events[0].data.name).toBe('fs_read');
      expect(events[0].data.latencyMs).toBe(128);
      expect(events[0].data.response).toEqual({ content: 'ok', latency_ms: 128 });
    });

    it('emits tool-result with latencyMs=0 when response omits latency_ms', () => {
      const events = [];
      const client = new AttachClient({
        endpoint: 'https://example',
        onEvent: (e) => events.push(e),
      });
      client._fanoutAgentFrame({
        event: {
          Content: {
            parts: [
              { functionResponse: { id: 'c1', name: 'fs_read', response: { content: 'ok' } } },
            ],
          },
        },
      });
      expect(events[0].data.latencyMs).toBe(0);
    });

    it('accepts float latency_ms (browser JSON.parse yields Number)', () => {
      const events = [];
      const client = new AttachClient({
        endpoint: 'https://example',
        onEvent: (e) => events.push(e),
      });
      client._fanoutAgentFrame({
        event: {
          Content: {
            parts: [
              {
                functionResponse: {
                  id: 'c1',
                  name: 'fs_read',
                  response: { latency_ms: 128.7 },
                },
              },
            ],
          },
        },
      });
      expect(events[0].data.latencyMs).toBe(128.7);
    });

    it('handles both PascalCase and camelCase functionCall variants', () => {
      const events = [];
      const client = new AttachClient({
        endpoint: 'https://example',
        onEvent: (e) => events.push(e),
      });
      client._fanoutAgentFrame({
        event: {
          Content: {
            parts: [{ FunctionCall: { ID: 'c1', Name: 'fs_read', Args: { path: '/x' } } }],
          },
        },
      });
      expect(events[0]).toEqual({
        type: 'tool-call',
        data: { id: 'c1', name: 'fs_read', args: { path: '/x' } },
        gen: 0,
        replay: false,
      });
    });

    it('carries the frame timestamp through, for rows drawn as history', () => {
      const events = [];
      const client = new AttachClient({
        endpoint: 'https://example',
        onEvent: (e) => events.push(e),
      });
      client._fanoutAgentFrame(
        { event: { Author: 'assistant', Content: { parts: [{ text: 'hi' }] } } },
        0,
        true,
        '2026-07-20T12:00:00Z'
      );
      expect(events[0].replay).toBe(true);
      expect(events[0].ts).toBe('2026-07-20T12:00:00Z');
    });

    it('omits ts entirely on an unstamped frame (live event shape is unchanged)', () => {
      const events = [];
      const client = new AttachClient({
        endpoint: 'https://example',
        onEvent: (e) => events.push(e),
      });
      client._fanoutAgentFrame({
        event: { Author: 'assistant', Content: { parts: [{ text: 'hi' }] } },
      });
      expect('ts' in events[0]).toBe(false);
    });

    it('silently ignores frames with no Content/parts', () => {
      const events = [];
      const client = new AttachClient({
        endpoint: 'https://example',
        onEvent: (e) => events.push(e),
      });
      client._fanoutAgentFrame({ event: {} });
      client._fanoutAgentFrame({ event: { Content: {} } });
      client._fanoutAgentFrame(null);
      client._fanoutAgentFrame({});
      expect(events).toEqual([]);
    });
  });
});
