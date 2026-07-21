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
      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&lt;script&gt;');
    });

    it('exports escapeHTML for callers', () => {
      expect(typeof SlashRender.escapeHTML).toBe('function');
      expect(SlashRender.escapeHTML('<a>&"\'"')).toContain('&lt;a&gt;');
      expect(SlashRender.escapeHTML('<a>&"\'"')).toContain('&amp;');
      expect(SlashRender.escapeHTML('<a>&"\'"')).toContain('&quot;');
    });
  });

  // ─── Registry (v0.3.0 PR 4 additions) ─────────────────────────────

  describe('register', () => {
    it('adds a new renderer that renderSlashResponse then dispatches to', () => {
      SlashRender.register(
        'shout',
        (r) => '<b>' + SlashRender.escapeHTML(String(r.body || '')).toUpperCase() + '</b>'
      );
      const html = SlashRender.renderSlashResponse({ _render: 'shout', body: 'hello' });
      expect(html).toBe('<b>HELLO</b>');
    });

    it('overwrites an existing renderer (last register wins)', () => {
      SlashRender.register('text', () => '<p>replaced</p>');
      const html = SlashRender.renderSlashResponse({ _render: 'text', body: 'x' });
      expect(html).toBe('<p>replaced</p>');
    });

    it('throws on non-string name', () => {
      expect(() => SlashRender.register('', () => '')).toThrow();
      expect(() => SlashRender.register(null, () => '')).toThrow();
    });

    it('throws on non-function renderer', () => {
      expect(() => SlashRender.register('foo', 'not-a-fn')).toThrow();
      expect(() => SlashRender.register('foo', null)).toThrow();
    });
  });

  // ─── Table renderer ──────────────────────────────────────────────

  describe('table renderer', () => {
    it('renders columns + rows into a semantic table', () => {
      const html = SlashRender.renderSlashResponse({
        _render: 'table',
        columns: ['name', 'cost'],
        rows: [
          ['gemini-2.5-flash', 0.001],
          ['gemini-2.5-pro', 0.02],
        ],
      });
      expect(html).toContain('<table>');
      expect(html).toContain('<th');
      expect(html).toContain('name</th>');
      expect(html).toContain('cost</th>');
      expect(html).toContain('gemini-2.5-flash');
      expect(html).toContain('0.02');
    });

    it('accepts column-object entries with label + align', () => {
      const html = SlashRender.renderSlashResponse({
        _render: 'table',
        columns: [
          { name: 'n', label: 'Name' },
          { name: 'c', label: 'Cost', align: 'right' },
        ],
        rows: [['a', 1]],
      });
      expect(html).toContain('Name</th>');
      expect(html).toContain('style="text-align:right"');
    });

    it('escapes HTML in header labels + cells (XSS defence)', () => {
      const html = SlashRender.renderSlashResponse({
        _render: 'table',
        columns: ['<danger>'],
        rows: [['<script>alert(1)</script>']],
      });
      expect(html).not.toContain('<danger>');
      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&lt;danger&gt;');
      expect(html).toContain('&lt;script&gt;');
    });

    it('stringifies object cells as JSON', () => {
      const html = SlashRender.renderSlashResponse({
        _render: 'table',
        columns: ['obj'],
        rows: [[{ a: 1 }]],
      });
      expect(html).toContain('{&quot;a&quot;:1}');
    });

    it('renders empty table when rows/columns absent', () => {
      const html = SlashRender.renderSlashResponse({ _render: 'table' });
      expect(html).toContain('<table>');
      expect(html).toContain('<thead>');
    });
  });

  // ─── Tree renderer ───────────────────────────────────────────────

  describe('tree renderer', () => {
    it('renders nested objects into <details> elements', () => {
      const html = SlashRender.renderSlashResponse({
        _render: 'tree',
        root: { a: { b: { c: 1 } } },
      });
      expect(html).toContain('<details');
      expect(html).toContain('slash-tree-key');
      expect(html).toContain('a</span>');
      expect(html).toContain('b</span>');
      expect(html).toContain('c:');
    });

    it('handles arrays with a count label', () => {
      const html = SlashRender.renderSlashResponse({
        _render: 'tree',
        root: [1, 2, 3],
      });
      expect(html).toContain('(3)');
    });

    it('marks null / empty object / empty array as leaves', () => {
      const html = SlashRender.renderSlashResponse({
        _render: 'tree',
        root: { n: null, e: {}, a: [] },
      });
      expect(html).toContain('<em>null</em>');
      expect(html).toContain('{}');
      expect(html).toContain('[]');
    });

    it('truncates strings longer than TREE_LONG_STRING', () => {
      const long = 'x'.repeat(500);
      const html = SlashRender.renderSlashResponse({
        _render: 'tree',
        root: { long },
      });
      expect(html).toContain('truncated, 500 chars');
      expect(html).not.toContain('x'.repeat(500));
    });

    it('accepts raw value when no root key present', () => {
      const html = SlashRender.renderSlashResponse({
        _render: 'tree',
        a: 1,
        b: 2,
      });
      // The whole response object becomes the root; slash-tree-key
      // shows _render / a / b under it.
      expect(html).toContain('slash-tree-key');
      expect(html).toContain('a:');
      expect(html).toContain('b:');
    });

    it('escapes HTML in tree keys + values', () => {
      const html = SlashRender.renderSlashResponse({
        _render: 'tree',
        root: { '<key>': '<danger>' },
      });
      expect(html).not.toContain('<key>');
      expect(html).not.toContain('<danger>');
      expect(html).toContain('&lt;key&gt;');
      expect(html).toContain('&lt;danger&gt;');
    });

    it('stops recursion at TREE_MAX_DEPTH', () => {
      // Build a chain of 20 nested objects (max depth is 12).
      let deep = { leaf: true };
      for (let i = 0; i < 20; i++) deep = { child: deep };
      const html = SlashRender.renderSlashResponse({ _render: 'tree', root: deep });
      expect(html).toContain('max depth');
    });
  });

  // ─── _schema validator ───────────────────────────────────────────

  describe('validate', () => {
    it('validates required object properties', () => {
      const r = SlashRender.validate({ x: 1 }, { type: 'object', required: ['x', 'y'] });
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes('y'))).toBe(true);
    });

    it('validates property types recursively', () => {
      const r = SlashRender.validate(
        { name: 'ok', age: 'not-a-number' },
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
        }
      );
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes('age'))).toBe(true);
    });

    it('validates array item types', () => {
      const r = SlashRender.validate([1, 2, 'three'], { type: 'array', items: { type: 'number' } });
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes('[2]'))).toBe(true);
    });

    it('type check reports null vs. object correctly', () => {
      const r = SlashRender.validate(null, { type: 'object' });
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toContain('null');
    });

    it('returns ok when schema is missing', () => {
      expect(SlashRender.validate({ x: 1 }, null).ok).toBe(true);
      expect(SlashRender.validate({ x: 1 }, undefined).ok).toBe(true);
    });
  });

  describe('_schema dispatch', () => {
    it('logs a warning on validation failure but still renders', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = SlashRender.renderSlashResponse({
        _render: 'table',
        _schema: '#/renderers/table',
        // Missing 'rows' — should trigger a schema warning.
        columns: ['a'],
      });
      expect(warn).toHaveBeenCalled();
      // Still rendered.
      expect(html).toContain('<table>');
      warn.mockRestore();
    });

    it('accepts inline schema object', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      SlashRender.renderSlashResponse({
        _render: 'json',
        _schema: { type: 'object', required: ['missing'] },
        payload: 1,
      });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('warns on unknown schema reference', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      SlashRender.renderSlashResponse({
        _render: 'json',
        _schema: '#/nonexistent/schema',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unknown _schema reference/));
      warn.mockRestore();
    });
  });
});
