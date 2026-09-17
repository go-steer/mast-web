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

  // ─── renderList ────────────────────────────────────────────────────

  describe('renderList', () => {
    it('renders a title, group headers, names, tags and descriptions', () => {
      const html = SlashRender.renderList('Tools (2)', [
        {
          header: 'builtin',
          items: [
            { name: 'fs_read', tags: ['allowed'], description: 'Read files' },
            { name: 'fs_write' },
          ],
        },
      ]);
      expect(html).toContain('<div class="list-title">Tools (2)</div>');
      expect(html).toContain('<div class="list-group-header">builtin</div>');
      expect(html).toContain('fs_read');
      expect(html).toContain('[allowed]');
      expect(html).toContain('Read files');
      // A row with neither description nor tags still renders.
      expect(html).toContain('fs_write');
    });

    it('renders opts.summary under the title and omits it otherwise', () => {
      expect(SlashRender.renderList('T', [], { summary: 'builtin 2 · gke 1' })).toContain(
        '<div class="list-summary">builtin 2 · gke 1</div>'
      );
      expect(SlashRender.renderList('T', [])).not.toContain('list-summary');
    });

    // An empty group is a fact about the backend — an MCP server with no
    // tools — not an absence to hide.
    it('prints (none) for an empty group rather than dropping it', () => {
      const html = SlashRender.renderList('T', [{ header: 'gke', items: [] }]);
      expect(html).toContain('gke');
      expect(html).toContain('(none)');
    });

    it('escapes every field', () => {
      const html = SlashRender.renderList('<t>', [
        {
          header: '<h>',
          items: [{ name: '<n>', tags: ['<g>'], description: '<d>' }],
        },
      ]);
      expect(html).not.toContain('<t>');
      expect(html).not.toContain('<h>');
      expect(html).not.toContain('<n>');
      expect(html).not.toContain('<g>');
      expect(html).not.toContain('<d>');
      expect(html).toContain('&lt;n&gt;');
    });

    it('tolerates a null group list and missing items', () => {
      expect(SlashRender.renderList('T', null)).toContain('list-title');
      expect(SlashRender.renderList('T', [{}])).toContain('(none)');
    });
  });

  // ─── /tools grouping (core-tui#289) ────────────────────────────────

  describe('groupToolsBySource', () => {
    const catalog = [
      { name: 'kube_get', source: 'other' },
      { name: 'gke_nodes', source: 'gke' },
      { name: 'fs_write', source: 'builtin' },
      { name: 'write_adr', source: 'skill:adr' },
      { name: 'fs_read', source: 'builtin' },
      { name: 'review_diff', source: 'skill:review' },
      { name: 'gh_pr_view', source: 'mcp', server: 'github' },
      { name: 'orphan' },
    ];

    it('orders builtin first, other last, the rest alphabetically', () => {
      const keys = SlashRender.groupToolsBySource(catalog).map(([k]) => k);
      expect(keys).toEqual(['builtin', 'github', 'gke', 'skill', 'other']);
    });

    it('folds every skill:<name> into one skill heading', () => {
      const skill = SlashRender.groupToolsBySource(catalog).find(([k]) => k === 'skill')[1];
      expect(skill.map((t) => t.name)).toEqual(['review_diff', 'write_adr']);
    });

    // Producers send MCP attribution both flattened (source is the
    // server's own name) and unflattened (source "mcp" + server).
    it('normalizes the unflattened source/server pair to the server name', () => {
      const keys = SlashRender.groupToolsBySource(catalog).map(([k]) => k);
      expect(keys).toContain('github');
      expect(keys).not.toContain('mcp');
    });

    it('buckets a sourceless tool under other rather than an unnamed group', () => {
      const other = SlashRender.groupToolsBySource(catalog).find(([k]) => k === 'other')[1];
      expect(other.map((t) => t.name).sort()).toEqual(['kube_get', 'orphan']);
    });

    it('sorts alphabetically within a group', () => {
      const builtin = SlashRender.groupToolsBySource(catalog).find(([k]) => k === 'builtin')[1];
      expect(builtin.map((t) => t.name)).toEqual(['fs_read', 'fs_write']);
    });

    it('accepts bare strings and an empty catalog', () => {
      expect(SlashRender.groupToolsBySource(['a', 'b'])).toEqual([
        ['other', [{ name: 'a' }, { name: 'b' }]],
      ]);
      expect(SlashRender.groupToolsBySource([])).toEqual([]);
      expect(SlashRender.groupToolsBySource(null)).toEqual([]);
    });
  });

  describe('renderTools', () => {
    const multi = [
      { name: 'fs_read', source: 'builtin', description: 'Read files', gate_state: 'allowed' },
      { name: 'gke_nodes', source: 'gke', description: 'List nodes' },
      { name: 'review_diff', source: 'skill:review', description: 'Review a diff' },
      { name: 'write_adr', source: 'skill:adr', description: 'Write a record' },
    ];

    it('groups with per-source counts and drops descriptions', () => {
      const { html } = SlashRender.renderTools(multi, '');
      expect(html).toContain('Tools (4): builtin 1 · gke 1 · skill 2');
      expect(html).toContain('<div class="list-group-header">skill (2)</div>');
      expect(html).toContain('/tools &lt;source&gt; for descriptions');
      expect(html).not.toContain('Read files');
    });

    // The gate is the one annotation worth its width in grouped mode:
    // "this will stop and ask" changes what the operator does next.
    it('keeps the gate annotation in grouped mode', () => {
      expect(SlashRender.renderTools(multi, '').html).toContain('[allowed]');
    });

    it('restores descriptions and the full source when filtered', () => {
      const { html } = SlashRender.renderTools(multi, 'skill');
      expect(html).toContain('Tools from skill (2)');
      expect(html).toContain('Review a diff');
      expect(html).toContain('skill:review');
      expect(html).not.toContain('gke_nodes');
    });

    it('matches a full source as well as a group key, case-insensitively', () => {
      expect(SlashRender.renderTools(multi, 'SKILL:ADR').html).toContain('write_adr');
      expect(SlashRender.renderTools(multi, 'SKILL:ADR').html).not.toContain('review_diff');
      expect(SlashRender.renderTools(multi, 'GKE').html).toContain('gke_nodes');
    });

    // A miss that only says "no" is a dead end: filtering by source is
    // the only reason to want the source names, so name them.
    it('names the available sources on a miss', () => {
      const { text, html } = SlashRender.renderTools(multi, 'nope');
      expect(html).toBeUndefined();
      expect(text).toBe('/tools: no tools from "nope". Sources: builtin, gke, skill');
    });

    // The pre-#289 layout, unchanged: grouping a catalog that has one
    // source only costs it a heading that says nothing.
    it('renders a single-source catalog in detail, ungrouped', () => {
      const one = [{ name: 'fs_read', source: 'builtin', description: 'Read files' }];
      const { html } = SlashRender.renderTools(one, '');
      expect(html).toContain('Tools (1)');
      expect(html).not.toContain('list-group-header');
      expect(html).not.toContain('list-summary');
      expect(html).toContain('Read files');
    });
  });

  // The grant a specialist was configured with (v1.9.0,
  // core-agent#768), and the absence that is not an emptiness.
  describe('renderSpecialists', () => {
    const roster = [
      {
        name: 'researcher',
        description: 'Research + summarize',
        model: 'mock-model-1.5',
        modes: ['sync', 'async'],
        tools: [
          { name: 'fs_read', source: 'builtin', description: 'Read files' },
          { name: 'gke_clusters_list', source: 'gke', description: 'List clusters' },
        ],
      },
      { name: 'implementer', description: 'Write + edit code', modes: ['async'] },
      { name: 'auditor', modes: ['async'], tools: [] },
    ];

    it('summarizes each grant the way /tools counts a catalog', () => {
      const { html } = SlashRender.renderSpecialists(roster, '');
      expect(html).toContain('Specialists (3)');
      expect(html).toContain('builtin 1 · gke 1');
    });

    // The whole point. A pre-1.9.0 daemon omits the key for every
    // specialist and a current one omits it for a specialist with no
    // grant, so "no tools" would be a guess — and against an older
    // backend, a wrong one every time.
    it('reports a missing grant as unknown, never as none', () => {
      const { html } = SlashRender.renderSpecialists(roster, '');
      expect(html).toContain('grant unknown');
      expect(html).toContain('1 report no grant, which is not the same as none');
    });

    // And the other side of it: a grant that IS reported as empty is
    // an answer, and gets a different word.
    it('distinguishes a reported-empty grant from a missing one', () => {
      const { html } = SlashRender.renderSpecialists(roster, '');
      expect(html).toContain('no tools of its own');
    });

    it('groups one specialist’s grant by source on request', () => {
      const { html } = SlashRender.renderSpecialists(roster, 'researcher');
      expect(html).toContain('researcher — mock-model-1.5 · sync/async');
      expect(html).toContain('<div class="list-group-header">builtin (1)</div>');
      expect(html).toContain('List clusters');
    });

    it('spells out both reasons a grant can be missing', () => {
      const { text, html } = SlashRender.renderSpecialists(roster, 'implementer');
      expect(html).toBeUndefined();
      expect(text).toContain('Tool grant: unknown');
      expect(text).toContain('predates v1.9.0');
      expect(text).toContain('no tools of its own');
    });

    // The three the runtime wires in regardless are a property of the
    // runtime, so an empty grant says something specific rather than
    // "this specialist can do nothing at all".
    it('notes the runtime-wired tools when the grant is empty', () => {
      const { text } = SlashRender.renderSpecialists(roster, 'auditor');
      expect(text).toContain('none of its own');
      expect(text).toContain('return_result');
    });

    it('names the roster on a miss', () => {
      const { text } = SlashRender.renderSpecialists(roster, 'ghost');
      expect(text).toBe(
        '/specialists: no specialist named "ghost". Registered: researcher, implementer, auditor'
      );
    });
  });

  describe('renderPerms', () => {
    const perms = {
      mode: 'ask',
      allow: ['fs_read'],
      deny: ['bash_exec rm -rf *'],
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
    };

    it('renders the mode, the patterns and the log', () => {
      const html = SlashRender.renderPerms(perms, { attribution: true });
      expect(html).toContain('Permissions — mode ask');
      expect(html).toContain('allow (1)');
      expect(html).toContain('approved this session (2)');
      expect(html).toContain('bash_exec git push');
    });

    // The two answers, side by side: a name, and the daemon saying it
    // has none. Never the reader's own identity — they are the
    // likeliest author of any row and the most damaging to assume,
    // because the log is read when something got through that
    // shouldn't have.
    it('names the approver where there is one and says so where there is not', () => {
      const html = SlashRender.renderPerms(perms, { attribution: true });
      expect(html).toContain('by ada@example.com');
      expect(html).toContain('unattributed');
    });

    // On a backend that cannot attribute, every row would say
    // "unattributed" and it would mean nothing. Say it once, about the
    // backend, and leave the rows alone.
    it('prints no per-row attribution when the backend has none to give', () => {
      const html = SlashRender.renderPerms(perms, { attribution: false });
      expect(html).not.toContain('unattributed');
      expect(html).not.toContain('by ada@example.com');
      expect(html).toContain('does not attribute approvals');
    });

    it('renders an empty log as a heading rather than as nothing', () => {
      const html = SlashRender.renderPerms({ mode: 'yolo' }, { attribution: true });
      expect(html).toContain('Permissions — mode yolo');
      expect(html).toContain('approved this session (0)');
      expect(html).toContain('(none)');
    });
  });

  describe('groupToolsByServer', () => {
    // The shape core-agent flattens to: the server's own name in
    // `source`, no `server` field at all.
    it('buckets flattened attribution under the server name', () => {
      const out = SlashRender.groupToolsByServer([
        { name: 'gke_nodes_list', source: 'gke', description: 'List nodes' },
        { name: 'gke_clusters_list', source: 'gke' },
      ]);
      expect(out).toEqual([
        {
          name: 'gke',
          status: 'connected',
          tools: [
            { name: 'gke_nodes_list', description: 'List nodes' },
            { name: 'gke_clusters_list', description: '' },
          ],
        },
      ]);
    });

    it('buckets unflattened source/server attribution', () => {
      const out = SlashRender.groupToolsByServer([
        { name: 'gh_pr_view', source: 'mcp', server: 'github' },
      ]);
      expect(out.map((s) => s.name)).toEqual(['github']);
    });

    // The fallback that keeps /mcp useful against a backend whose
    // adapter reports source 'other' for everything it hasn't
    // attributed yet.
    it('falls back to the <server>_<tool> convention when unattributed', () => {
      const out = SlashRender.groupToolsByServer([
        { name: 'kube_get', source: 'other' },
        { name: 'kube_apply' },
      ]);
      expect(out).toEqual([
        {
          name: 'kube',
          status: 'connected',
          tools: [
            { name: 'kube_get', description: '' },
            { name: 'kube_apply', description: '' },
          ],
        },
      ]);
    });

    // The bug the fallback used to have: splitting every underscored
    // name invents a server called "fs" out of a built-in.
    it('excludes builtin, skill and subagent tools rather than guessing', () => {
      const out = SlashRender.groupToolsByServer([
        { name: 'fs_read', source: 'builtin' },
        { name: 'review_diff', source: 'skill:review' },
        { name: 'delegate', source: 'subagent' },
      ]);
      expect(out).toEqual([]);
    });

    it('skips an unattributed tool with no underscore to split on', () => {
      expect(SlashRender.groupToolsByServer([{ name: 'lookup' }])).toEqual([]);
      expect(SlashRender.groupToolsByServer([{ name: '_leading' }])).toEqual([]);
    });

    it('sorts servers by name and tolerates junk input', () => {
      const out = SlashRender.groupToolsByServer([
        { name: 'zoo_list', source: 'zoo' },
        { name: 'aviary_list', source: 'aviary' },
        { name: '' },
        'gh_pr_view',
      ]);
      expect(out.map((s) => s.name)).toEqual(['aviary', 'gh', 'zoo']);
      expect(SlashRender.groupToolsByServer(null)).toEqual([]);
    });
  });

  describe('formatGuardrails', () => {
    it('reports mode, spend, trips and the reset usage line', () => {
      const text = SlashRender.formatGuardrails({
        watchdog: { mode: 'enforce', tripped: true, reason: 'loop detected' },
        cost_ceiling: { session_cost_usd: 1.5, max_session_usd: 2, tripped: false },
        halted: true,
      });
      expect(text).toContain('mode=enforce tripped=true (loop detected)');
      expect(text).toContain('$1.50 / $2.00 tripped=false');
      expect(text).toContain('Halted:        true');
      expect(text).toContain('/guardrails reset [watchdog|cost_ceiling|all]');
    });

    // The zero-value shape a backend with no GuardrailProvider returns
    // — always a 200, so this is the common answer, not an edge case.
    it('reads an empty payload as off and untripped', () => {
      const text = SlashRender.formatGuardrails({});
      expect(text).toContain('mode=off tripped=false');
      expect(text).toContain('$0.00 / $0.00 tripped=false');
      expect(text).toContain('Halted:        false');
    });

    it('omits the parenthetical when there is no reason', () => {
      expect(SlashRender.formatGuardrails(null)).not.toContain('(');
    });
  });

  describe('summarizeAgentEvent', () => {
    it('falls back when the protocol module is absent', () => {
      delete globalThis.AttachCoreProtocol;
      expect(SlashRender.summarizeAgentEvent({})).toBe('(event)');
    });

    it('summarizes text, calls and results from the fanout', () => {
      globalThis.AttachCoreProtocol = {
        fanoutAgentFrame(_frame, emit) {
          emit({ type: 'stream-chunk', data: { text: 'hello' } });
          emit({ type: 'tool-call', data: { name: 'fs_read' } });
          emit({ type: 'tool-result', data: { name: 'fs_read', latencyMs: 12 } });
        },
      };
      expect(SlashRender.summarizeAgentEvent({})).toBe(
        'text: hello; call fs_read; result fs_read (12ms)'
      );
      delete globalThis.AttachCoreProtocol;
    });

    it('reports an event that fans out to nothing', () => {
      globalThis.AttachCoreProtocol = { fanoutAgentFrame() {} };
      expect(SlashRender.summarizeAgentEvent({})).toBe('(empty)');
      delete globalThis.AttachCoreProtocol;
    });
  });
});
