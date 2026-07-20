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

// Unit tests for web/slash-render.js.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'slash-render.js'), 'utf8');

function loadSlashRender() {
  new Function('window', src)(globalThis);
  return globalThis.SlashRender;
}

describe('SlashRender', () => {
  let SlashRender;
  beforeEach(() => {
    delete globalThis.SlashRender;
    delete globalThis.marked;
    SlashRender = loadSlashRender();
  });

  it('exports renderSlashResponse, RENDERERS, RESERVED_KEYS', () => {
    expect(typeof SlashRender.renderSlashResponse).toBe('function');
    expect(typeof SlashRender.RENDERERS).toBe('object');
    expect(SlashRender.RESERVED_KEYS).toEqual(['_render', '_schema']);
  });

  describe('renderSlashResponse — dispatch', () => {
    it('defaults to json renderer when _render is absent', () => {
      const html = SlashRender.renderSlashResponse({ foo: 'bar' });
      expect(html).toMatch(/<pre class="slash-render-json">/);
      expect(html).toContain('&quot;foo&quot;: &quot;bar&quot;');
    });

    it('routes to text renderer when _render: "text"', () => {
      const html = SlashRender.renderSlashResponse({ _render: 'text', body: 'hello world' });
      expect(html).toMatch(/<pre class="slash-render-text">/);
      expect(html).toContain('hello world');
    });

    it('routes to markdown renderer when _render: "markdown" + marked available', () => {
      globalThis.marked = { parse: vi.fn((s) => '<h1>' + s + '</h1>') };
      const html = SlashRender.renderSlashResponse({ _render: 'markdown', body: 'Title' });
      expect(html).toBe('<h1>Title</h1>');
      expect(globalThis.marked.parse).toHaveBeenCalledWith('Title');
    });

    it('markdown renderer falls back to text-in-pre when marked unavailable', () => {
      // Don't set globalThis.marked
      const html = SlashRender.renderSlashResponse({ _render: 'markdown', body: '# X' });
      expect(html).toMatch(/<pre class="slash-render-text">/);
      expect(html).toContain('# X');
    });

    it('unknown _render value falls back to json + warns (forward-compat)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = SlashRender.renderSlashResponse({ _render: 'chart', data: [1, 2] });
      expect(html).toMatch(/<pre class="slash-render-json">/);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unknown _render value "chart"/));
      warn.mockRestore();
    });

    it('handles null / undefined response gracefully', () => {
      expect(SlashRender.renderSlashResponse(null)).toBe(
        '<pre class="slash-render-empty">(empty response)</pre>'
      );
      expect(SlashRender.renderSlashResponse(undefined)).toBe(
        '<pre class="slash-render-empty">(empty response)</pre>'
      );
    });

    it('handles string response with default json renderer', () => {
      const html = SlashRender.renderSlashResponse('a plain string');
      // A string isn't an object; the default json renderer stringifies.
      expect(html).toMatch(/<pre class="slash-render-json">/);
      expect(html).toContain('a plain string');
    });

    it('does not mutate the input', () => {
      const input = { _render: 'json', data: { x: 1 } };
      const snapshot = JSON.parse(JSON.stringify(input));
      SlashRender.renderSlashResponse(input);
      expect(input).toEqual(snapshot);
    });
  });

  describe('json renderer — reserved-key stripping', () => {
    it('strips _render + _schema from the displayed body', () => {
      const html = SlashRender.RENDERERS.json({
        _render: 'json',
        _schema: 'ref://compact-response',
        summary: 'ok',
        turns_saved: 3,
      });
      expect(html).not.toContain('_render');
      expect(html).not.toContain('_schema');
      expect(html).toContain('summary');
      expect(html).toContain('turns_saved');
    });

    it('leaves non-reserved keys intact', () => {
      const html = SlashRender.RENDERERS.json({ foo: 'bar', baz: 42 });
      expect(html).toContain('&quot;foo&quot;: &quot;bar&quot;');
      expect(html).toContain('&quot;baz&quot;: 42');
    });
  });

  describe('escapeHTML', () => {
    it('escapes < > & inside rendered content (defense against injection)', () => {
      const html = SlashRender.renderSlashResponse({
        _render: 'text',
        body: '<script>alert("xss")</script>',
      });
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});
