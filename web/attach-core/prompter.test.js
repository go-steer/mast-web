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

// Unit tests for web/attach-core/prompter.js. Uses jsdom's fetch
// mock; EventSource behaviour is hard to exercise reliably under
// jsdom so we cover HTTP methods (respond / allow / deny) and the
// URL construction logic directly.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcPrompter = readFileSync(join(here, 'prompter.js'), 'utf8');

function loadPrompter() {
  new Function('window', srcPrompter)(globalThis);
  return globalThis.AttachCorePrompter;
}

describe('AttachCorePrompter', () => {
  let AttachCorePrompter;
  beforeEach(() => {
    delete globalThis.AttachCorePrompter;
    AttachCorePrompter = loadPrompter();
  });

  it('exports Prompter + BACKOFF_SCHEDULE_MS', () => {
    expect(AttachCorePrompter.Prompter).toBeDefined();
    expect(AttachCorePrompter.BACKOFF_SCHEDULE_MS).toEqual([5000, 10000, 30000]);
  });

  describe('respond', () => {
    it('POSTs {id, decision} to /perms/respond with auth headers', async () => {
      const p = new AttachCorePrompter.Prompter({
        endpoint: 'https://example',
        token: 'secret',
        sessionId: 's1',
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });
      await p.respond('prompt-42', 'allow-once');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = globalThis.fetch.mock.calls[0];
      expect(url).toBe('https://example/sessions/s1/perms/respond');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ id: 'prompt-42', decision: 'allow-once' });
      // Both Bearer and X-Attach-Token headers are set (matches the
      // client's dual-header auth for proxy-friendly deployments).
      expect(opts.headers['Authorization']).toBe('Bearer secret');
      expect(opts.headers['X-Attach-Token']).toBe('secret');
    });

    it('respond throws on non-OK response', async () => {
      const p = new AttachCorePrompter.Prompter({
        endpoint: 'https://example',
        sessionId: 's1',
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('bad decision'),
      });
      await expect(p.respond('x', 'invalid')).rejects.toThrow(/HTTP 400/);
    });
  });

  describe('allow / deny batch endpoints', () => {
    it('allow POSTs {patterns} to /perms/allow', async () => {
      const p = new AttachCorePrompter.Prompter({ endpoint: 'https://example', sessionId: 's1' });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });
      await p.allow(['bash:git *', 'file_write:/tmp/*']);
      const [url, opts] = globalThis.fetch.mock.calls[0];
      expect(url).toBe('https://example/sessions/s1/perms/allow');
      expect(JSON.parse(opts.body)).toEqual({ patterns: ['bash:git *', 'file_write:/tmp/*'] });
    });

    it('deny POSTs {patterns} to /perms/deny', async () => {
      const p = new AttachCorePrompter.Prompter({ endpoint: 'https://example', sessionId: 's1' });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });
      await p.deny(['bash:rm *']);
      const [url] = globalThis.fetch.mock.calls[0];
      expect(url).toBe('https://example/sessions/s1/perms/deny');
    });

    it('allow with empty patterns still POSTs (empty allowlist noop)', async () => {
      const p = new AttachCorePrompter.Prompter({ endpoint: 'https://example', sessionId: 's1' });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });
      await p.allow();
      const [, opts] = globalThis.fetch.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({ patterns: [] });
    });
  });

  describe('URL construction', () => {
    // Regression guard: this used to append ?access_token=<token>,
    // which authenticated nothing (core-agent's checkAttachToken reads
    // only X-Attach-Token / Authorization) and leaked the credential
    // into proxy access logs. The token must never reach the URL.
    it('_streamURL never puts the token in the query string', () => {
      const p = new AttachCorePrompter.Prompter({
        endpoint: 'https://example',
        token: 'secret',
        sessionId: 'sess-abc',
      });
      const url = p._streamURL();
      expect(url).toBe('https://example/sessions/sess-abc/perms/stream');
      expect(url).not.toContain('secret');
      expect(url).not.toContain('access_token');
    });

    it('_streamURL omits query param when no token (unauthenticated dev)', () => {
      const p = new AttachCorePrompter.Prompter({
        endpoint: 'https://example',
        sessionId: 'sess-abc',
      });
      expect(p._streamURL()).toBe('https://example/sessions/sess-abc/perms/stream');
    });

    it('_streamURL URL-encodes the session id', () => {
      const p = new AttachCorePrompter.Prompter({
        endpoint: 'https://example',
        sessionId: 'weird sid/with slash',
      });
      expect(p._streamURL()).toBe(
        'https://example/sessions/weird%20sid%2Fwith%20slash/perms/stream'
      );
    });

    it('constructor trims trailing slash from endpoint', () => {
      const p = new AttachCorePrompter.Prompter({
        endpoint: 'https://example/',
        sessionId: 's1',
      });
      expect(p.endpoint).toBe('https://example');
    });
  });

  describe('lifecycle', () => {
    it('disconnect is idempotent + safe on never-connected instance', () => {
      const p = new AttachCorePrompter.Prompter({});
      expect(() => p.disconnect()).not.toThrow();
      expect(() => p.disconnect()).not.toThrow();
    });
  });
});
