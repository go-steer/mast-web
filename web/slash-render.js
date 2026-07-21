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

// slash-render — renderer registry for server-side slash command
// responses. v0.3.0 grew this from a fixed 3-renderer dispatch
// skeleton (v0.2.0 PR 4a) into a real registry that consumers can
// extend without touching this file, with two new built-ins (table +
// tree) and a small hand-rolled `_schema` validator.
//
// Response conventions the SPA consumes (reserved in core-tui/docs/
// sse-event-stream-protocol.md §6 as of v1.4.0):
//
//   _render   — chooses the renderer. Built-ins: "text" | "markdown"
//               | "json" | "table" | "tree". Absent defaults to
//               "json". Unknown values fall back to "json" with a
//               console warning (forward-compat with future spec
//               additions).
//   _schema   — optional. When present, response body is validated
//               against a schema before rendering. v0.3.0 supports:
//                 - Object schema literal: { type, required, properties }
//                 - Named reference: "#/renderers/table" resolves to
//                   the built-in schema for that renderer.
//               Validation failures log a warning to console but
//               still render — schema mismatch is a v0.4+ hard-fail
//               policy call.
//
// Public API on window.SlashRender:
//   renderSlashResponse(response)
//     — dispatch entry point. Returns an HTML string ready to inject
//       into a message container. HTML-escapes all user/server text
//       (XSS defence).
//   register(name, renderer)
//     — extend the registry at runtime. `renderer` is a function
//       (response) → HTML string. Overwriting a built-in is allowed.
//   RENDERERS          — snapshot of the current registry (read-only
//                        by convention).
//   RESERVED_KEYS      — the set of _render / _schema reserved keys.
//   SCHEMAS            — canonical schema definitions for built-ins.
//   validate(value, schema) — the small validator. Returns
//                             {ok, errors[]}.
//   escapeHTML         — exported for consumers that need it (e.g.
//                        addSystemMessageHTML in app.js).

window.SlashRender = (function () {
  'use strict';

  // ─── HTML escape (XSS defence) ────────────────────────────────────

  function escapeHTML(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── Reserved keys ────────────────────────────────────────────────

  const RESERVED_KEYS = ['_render', '_schema'];

  function stripReservedKeys(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!RESERVED_KEYS.includes(k)) out[k] = v;
    }
    return out;
  }

  // ─── Schema validator (small, hand-rolled) ─────────────────────────
  //
  // Supports a subset of JSON Schema Draft-07:
  //   - type: "object" | "array" | "string" | "number" | "boolean" | "null"
  //   - required: [names] — for object types
  //   - properties: { name: subschema } — for object types
  //   - items: subschema — for array types
  //
  // Returns { ok: bool, errors: [ "field.path: message", ... ] }.
  // Deliberately not full Draft-07 — see the module header. If we
  // outgrow this, Ajv is the natural next step.

  function validate(value, schema, path) {
    path = path || '$';
    const errors = [];
    if (!schema || typeof schema !== 'object') {
      return { ok: true, errors };
    }
    if (schema.type) {
      const t = typeOf(value);
      if (t !== schema.type) {
        errors.push(`${path}: expected ${schema.type}, got ${t}`);
        return { ok: false, errors };
      }
    }
    if (schema.type === 'object' && schema.required) {
      for (const key of schema.required) {
        if (!(key in (value || {}))) {
          errors.push(`${path}.${key}: required`);
        }
      }
    }
    if (schema.type === 'object' && schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (value && key in value) {
          const r = validate(value[key], sub, `${path}.${key}`);
          errors.push(...r.errors);
        }
      }
    }
    if (schema.type === 'array' && schema.items) {
      const arr = value || [];
      for (let i = 0; i < arr.length; i++) {
        const r = validate(arr[i], schema.items, `${path}[${i}]`);
        errors.push(...r.errors);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  // ─── Built-in schemas ────────────────────────────────────────────

  const SCHEMAS = {
    // #/renderers/table — { columns: [name...], rows: [[val...], ...] }
    // Optional per-column {name, label, align} objects supported via
    // duck-typing in the renderer; not enforced by schema.
    'renderers/table': {
      type: 'object',
      required: ['columns', 'rows'],
      properties: {
        columns: { type: 'array' },
        rows: { type: 'array' },
      },
    },
    // #/renderers/tree — { root: any } — root is rendered as a
    // collapsible tree with nested object / array / scalar leaves.
    'renderers/tree': {
      type: 'object',
      required: ['root'],
      // No sub-schema on root — the tree renderer accepts arbitrary
      // JSON.
    },
  };

  // Resolve a schema reference. Supports:
  //   - literal object (returned verbatim)
  //   - "#/renderers/<name>" style references into SCHEMAS
  //   - anything else → null (no schema — validation skipped)
  function resolveSchema(schemaRef) {
    if (!schemaRef) return null;
    if (typeof schemaRef === 'object') return schemaRef;
    if (typeof schemaRef === 'string' && schemaRef.startsWith('#/')) {
      const key = schemaRef.slice(2);
      return SCHEMAS[key] || null;
    }
    return null;
  }

  // ─── Renderer registry ───────────────────────────────────────────

  const RENDERERS = {};

  function register(name, fn) {
    if (typeof name !== 'string' || !name) {
      throw new Error('SlashRender.register: name must be a non-empty string');
    }
    if (typeof fn !== 'function') {
      throw new Error('SlashRender.register: renderer must be a function');
    }
    RENDERERS[name] = fn;
  }

  // ─── Built-in renderers ──────────────────────────────────────────
  // Registered via register() so external consumers can override.

  register('text', function textRenderer(response) {
    const text = typeof response === 'string' ? response : String(response.body ?? '');
    return '<pre class="slash-render-text">' + escapeHTML(text) + '</pre>';
  });

  register('markdown', function markdownRenderer(response) {
    const body = typeof response === 'string' ? response : String(response.body ?? '');
    // Uses the same `marked` pipeline the streaming assistant
    // messages render through. Falls back to escaped text when
    // marked isn't available (tests / stripped bundle).
    if (typeof window.marked === 'object' && typeof window.marked.parse === 'function') {
      return window.marked.parse(body);
    }
    return '<pre class="slash-render-text">' + escapeHTML(body) + '</pre>';
  });

  register('json', function jsonRenderer(response) {
    const stripped = stripReservedKeys(response);
    const pretty = JSON.stringify(stripped, null, 2);
    return '<pre class="slash-render-json">' + escapeHTML(pretty) + '</pre>';
  });

  // Table renderer — renders {columns, rows} as a semantic HTML
  // table with click-to-sort column headers.
  //
  // columns: either an array of strings (used as header + key) or an
  //          array of {name, label?, align?} objects. The array
  //          order determines rendering order.
  // rows:    array of arrays; each inner array is one row, aligned
  //          to columns by index. Cells may be any scalar; objects
  //          are JSON-stringified.
  //
  // Sorting is opt-in via clicking headers (small client-side JS
  // that lives in the rendered HTML — no external event wiring
  // needed). Numeric vs. string sort is auto-detected per column.
  register('table', function tableRenderer(response) {
    const cols = Array.isArray(response.columns) ? response.columns : [];
    const rows = Array.isArray(response.rows) ? response.rows : [];
    const headerCells = cols
      .map((c) => {
        const label = typeof c === 'string' ? c : c.label || c.name || '';
        const align = typeof c === 'object' && c.align ? c.align : '';
        const alignAttr = align ? ` style="text-align:${escapeHTML(align)}"` : '';
        return `<th${alignAttr} data-slash-sort tabindex="0" role="button">${escapeHTML(label)}</th>`;
      })
      .join('');
    const bodyRows = rows
      .map((r) => {
        const cells = (Array.isArray(r) ? r : [])
          .map((cell) => {
            const text =
              cell === null || cell === undefined
                ? ''
                : typeof cell === 'object'
                  ? JSON.stringify(cell)
                  : String(cell);
            return `<td>${escapeHTML(text)}</td>`;
          })
          .join('');
        return `<tr>${cells}</tr>`;
      })
      .join('');
    // Inline the sort behavior as an IIFE attribute — no event
    // wiring required from the caller. Small enough to not warrant
    // a real component.
    const sortScript =
      "(function(t){t.querySelectorAll('th[data-slash-sort]').forEach(function(th,i){th.addEventListener('click',function(){var tb=t.tBodies[0];var rows=Array.from(tb.rows);var dir=th.dataset.dir==='asc'?'desc':'asc';th.dataset.dir=dir;rows.sort(function(a,b){var x=a.cells[i].textContent;var y=b.cells[i].textContent;var xn=parseFloat(x),yn=parseFloat(y);if(!isNaN(xn)&&!isNaN(yn)){return dir==='asc'?xn-yn:yn-xn;}return dir==='asc'?x.localeCompare(y):y.localeCompare(x);});rows.forEach(function(r){tb.appendChild(r);});});});})";
    // Wrap the table in a div with a unique-ish id so the IIFE finds
    // the right element. crypto.randomUUID would be ideal but not
    // universally available in older jsdom; use a Math.random suffix
    // that's collision-free enough for one page.
    const id = 'slash-table-' + Math.random().toString(36).slice(2, 10);
    return (
      `<div class="slash-render-table" id="${id}">` +
      '<table><thead><tr>' +
      headerCells +
      '</tr></thead><tbody>' +
      bodyRows +
      '</tbody></table></div>' +
      `<script>${sortScript}(document.getElementById('${id}'));</script>`
    );
  });

  // Tree renderer — renders arbitrary JSON as a nested collapsible
  // structure using the browser's native <details> element (no JS
  // required for expand/collapse). Depth-limited to prevent
  // pathological input; scalar leaves rendered inline.
  //
  // Response shape: { root: any } — root is the value to render.
  // Also accepts the raw value if response has no `root` key —
  // useful for ad-hoc rendering.
  const TREE_MAX_DEPTH = 12;
  const TREE_LONG_STRING = 400;

  register('tree', function treeRenderer(response) {
    const root =
      response && typeof response === 'object' && 'root' in response ? response.root : response;
    return '<div class="slash-render-tree">' + renderTreeNode(root, 'root', 0) + '</div>';
  });

  function renderTreeNode(value, label, depth) {
    if (depth > TREE_MAX_DEPTH) {
      return `<div class="slash-tree-truncated">${escapeHTML(label)}: <em>(max depth ${TREE_MAX_DEPTH} exceeded)</em></div>`;
    }
    if (value === null) {
      return `<div class="slash-tree-leaf"><span class="slash-tree-key">${escapeHTML(label)}:</span> <em>null</em></div>`;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return `<div class="slash-tree-leaf"><span class="slash-tree-key">${escapeHTML(label)}:</span> []</div>`;
      }
      const children = value.map((item, i) => renderTreeNode(item, `[${i}]`, depth + 1)).join('');
      return (
        `<details class="slash-tree-node" open><summary><span class="slash-tree-key">${escapeHTML(label)}</span> ` +
        `<span class="slash-tree-count">(${value.length})</span></summary>` +
        children +
        '</details>'
      );
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 0) {
        return `<div class="slash-tree-leaf"><span class="slash-tree-key">${escapeHTML(label)}:</span> {}</div>`;
      }
      const children = keys.map((k) => renderTreeNode(value[k], k, depth + 1)).join('');
      return (
        `<details class="slash-tree-node" open><summary><span class="slash-tree-key">${escapeHTML(label)}</span> ` +
        `<span class="slash-tree-count">{${keys.length}}</span></summary>` +
        children +
        '</details>'
      );
    }
    // Scalar leaf.
    let text = String(value);
    let truncated = '';
    if (text.length > TREE_LONG_STRING) {
      truncated = ` <em class="slash-tree-truncated-hint">(truncated, ${text.length} chars)</em>`;
      text = text.slice(0, TREE_LONG_STRING) + '…';
    }
    return `<div class="slash-tree-leaf"><span class="slash-tree-key">${escapeHTML(label)}:</span> <span class="slash-tree-value">${escapeHTML(text)}</span>${truncated}</div>`;
  }

  // ─── Dispatch ────────────────────────────────────────────────────

  function renderSlashResponse(response) {
    if (response == null) return '<pre class="slash-render-empty">(empty response)</pre>';
    const hint =
      typeof response === 'object' &&
      !Array.isArray(response) &&
      typeof response._render === 'string'
        ? response._render
        : 'json';

    // Optional _schema validation — logs but doesn't fail-hard so a
    // schema mismatch never blocks rendering.
    if (typeof response === 'object' && !Array.isArray(response) && response._schema != null) {
      const schema = resolveSchema(response._schema);
      if (schema) {
        const r = validate(response, schema);
        if (!r.ok) {
          for (const err of r.errors) {
            console.warn('slash-render: schema validation:', err);
          }
        }
      } else if (typeof response._schema === 'string') {
        console.warn(
          'slash-render: unknown _schema reference "' + response._schema + '" — skipping validation'
        );
      }
    }

    const renderer = RENDERERS[hint];
    if (!renderer) {
      console.warn('slash-render: unknown _render value "' + hint + '" — falling back to json');
      return RENDERERS.json(response);
    }
    return renderer(response);
  }

  return {
    renderSlashResponse,
    register,
    RENDERERS,
    RESERVED_KEYS,
    SCHEMAS,
    validate,
    escapeHTML,
  };
})();
