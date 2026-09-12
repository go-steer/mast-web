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
// sse-event-stream-protocol.md §6, reserved in v1.4.0 and unchanged
// through v1.7.0):
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
//   renderList(title, groups, opts)
//     — the catalog list every client-side built-in renders into:
//       /tools, /subagents, /mcp. Lifted out of app.js so the
//       surviving shells get the same output instead of a second
//       copy. See the note above the function for the grouping rules.
//   renderTools(tools, filter)
//     — /tools, whole. Returns {html} or {text}: the source-grouped
//       catalog, the filtered detail view, or the miss that names the
//       sources on offer. Here rather than in a shell because the
//       grouping rules are the interesting part and there should be
//       one of them.
//   groupToolsBySource(tools)
//     — [[groupKey, tools], …] in heading order. Exported for tests
//       and for anything that wants the buckets without the markup.
//   groupToolsByServer(tools)
//     — /mcp's view of the same catalog: [{name, status, tools}] per
//       MCP server, with the naming-convention fallback for backends
//       that don't attribute their MCP tools yet.
//   formatGuardrails(guardrails)
//     — the /guardrails report as plain text.
//   summarizeAgentEvent(event)
//     — one plain-text line for a persisted subagent turn event, for
//       the `/subagents events` drill-down.

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

  // ─── Catalog lists ────────────────────────────────────────────────
  //
  // Shared by the client-side built-ins that print a roster — /tools,
  // /subagents, /mcp. Lifted out of app.js's renderListHTML so the
  // shells that survive v0.4 render the same thing rather than growing
  // a second copy of it.
  //
  // `groups` is [{header?, items: [{name, tags?, description?}]}].
  // A group with no items prints "(none)" rather than vanishing —
  // an empty MCP server is a fact about the backend, not an absence.
  //
  // opts.summary prints one line under the title. It exists for the
  // grouped /tools header ("builtin 14 · gke 31 · skill 9"), which is
  // the whole point of grouping: the counts are what tell an operator
  // whether the list they are about to scroll is theirs or a server's.
  function renderList(title, groups, opts) {
    const o = opts || {};
    const parts = [`<div class="list-title">${escapeHTML(title)}</div>`];
    if (o.summary) {
      parts.push(`<div class="list-summary">${escapeHTML(o.summary)}</div>`);
    }
    (groups || []).forEach((g) => {
      if (g.header) {
        parts.push(`<div class="list-group-header">${escapeHTML(g.header)}</div>`);
      }
      const items = g.items || [];
      if (items.length === 0) {
        parts.push('<div class="list-item-desc">(none)</div>');
        return;
      }
      items.forEach((it) => {
        const tags =
          it.tags && it.tags.length
            ? ` <span class="list-item-tags">[${escapeHTML(it.tags.join(', '))}]</span>`
            : '';
        parts.push(
          `<div class="list-item">` +
            `<div class="list-item-name">▸ ${escapeHTML(it.name)}${tags}</div>` +
            (it.description
              ? `<div class="list-item-desc">${escapeHTML(it.description)}</div>`
              : '') +
            `</div>`
        );
      });
    });
    return parts.join('');
  }

  // ─── /tools ───────────────────────────────────────────────────────
  //
  // The catalog used to render as one flat alphabetical run with a
  // description under every row. That was right for the ~14 built-ins a
  // host reported when app.js's version was written, and it stopped
  // being right when hosts started reporting their MCP and skill tools
  // too (core-agent#827, core-tui#289): the operator's own built-ins
  // end up interleaved into a wall of server rows, the one tool they
  // came for is buried, and the descriptions — most of the vertical
  // space — are what buries it.
  //
  // Two modes, split on how much the operator already knows:
  //
  //   Grouped (the default, and only when there is more than one
  //   source). Per-source counts, a heading per source, bare names. No
  //   descriptions: the operator is scanning for a name.
  //
  //   Detailed, with descriptions, for `/tools <source>` and for a
  //   catalog with one source anyway. There the operator has already
  //   narrowed to a set small enough to read, which is the point at
  //   which a description earns its rows — so a single-source catalog
  //   renders exactly as it did before.

  // core-agent flattens its Source/Server pair into one column, so an
  // MCP tool reports its server's own name rather than the bare word
  // "mcp". Older producers send the pair unflattened; normalizing here
  // means everything downstream sees one shape.
  function toolSource(t) {
    if (!t) return '';
    if (t.source === 'mcp' && t.server) return t.server;
    return t.source || '';
  }

  // The heading a source falls under: everything before a colon is the
  // family, so a session's several `skill:<name>` sources collapse to
  // one "skill" heading instead of one heading each. Nothing is lost —
  // the row keeps the full source in its annotation when it's shown at
  // all. An empty source groups under "other" rather than under "",
  // which would render a heading with no name.
  function toolGroupKey(source) {
    if (!source) return 'other';
    const colon = source.indexOf(':');
    return colon > 0 ? source.slice(0, colon) : source;
  }

  // builtin first because it's the set the operator already knows,
  // other last because it's the leftovers, the rest alphabetical.
  function toolGroupRank(key) {
    if (key === 'builtin') return 0;
    if (key === 'other') return 2;
    return 1;
  }

  // → [[key, tools], …] in heading order, alphabetical within a group.
  function groupToolsBySource(tools) {
    const sorted = (tools || [])
      .map((t) => (typeof t === 'string' ? { name: t } : t))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const byKey = new Map();
    sorted.forEach((t) => {
      const key = toolGroupKey(toolSource(t));
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(t);
    });
    return [...byKey.entries()].sort((a, b) => {
      const ra = toolGroupRank(a[0]);
      const rb = toolGroupRank(b[0]);
      return ra !== rb ? ra - rb : a[0].localeCompare(b[0]);
    });
  }

  // Grouped rows keep the gate and drop the description: "this one will
  // stop and ask" changes what the operator does next, where the
  // description only tells them what they came here already knowing.
  // Detail rows carry the full source too, since the heading that would
  // have supplied it isn't there.
  function toolRow(t, detailed) {
    const tags = [];
    const source = toolSource(t);
    if (detailed && source) tags.push(source);
    if (t.gate_state) tags.push(t.gate_state);
    return { name: t.name || String(t), tags, description: detailed ? t.description : '' };
  }

  // Returns {html} to render, or {text} for the one answer that isn't a
  // list. The caller picks the system-message flavour; this decides
  // what the answer is.
  function renderTools(tools, filter) {
    const grouped = groupToolsBySource(tools);
    const keys = grouped.map(([key]) => key);
    const want = String(filter || '').toLowerCase();

    if (want) {
      // Matches a group key ("skill") or a full source ("skill:review",
      // "gke"), case-insensitively, across every group.
      const hits = [];
      grouped.forEach(([key, entries]) => {
        entries.forEach((t) => {
          if (key.toLowerCase() === want || toolSource(t).toLowerCase() === want) hits.push(t);
        });
      });
      if (hits.length === 0) {
        // Name the sources that do exist. Filtering by source is the
        // only reason to want those names, so an operator who guessed
        // wrong has no other way to learn them — this is the difference
        // between a dead end and a discovery.
        return { text: `/tools: no tools from "${filter}". Sources: ` + keys.join(', ') };
      }
      return {
        html: renderList(`Tools from ${filter} (${hits.length})`, [
          { items: hits.map((t) => toolRow(t, true)) },
        ]),
      };
    }

    // One source is not a grouping problem — a heading over the whole
    // catalog says nothing the count didn't.
    if (grouped.length === 1) {
      return {
        html: renderList(`Tools (${tools.length})`, [
          { items: grouped[0][1].map((t) => toolRow(t, true)) },
        ]),
      };
    }

    const counts = grouped.map(([key, entries]) => `${key} ${entries.length}`).join(' · ');
    return {
      html: renderList(
        `Tools (${tools.length}): ${counts}`,
        grouped.map(([key, entries]) => ({
          header: `${key} (${entries.length})`,
          items: entries.map((t) => toolRow(t, false)),
        })),
        { summary: '/tools <source> for descriptions' }
      ),
    };
  }

  // /mcp buckets the same catalog by MCP server and nothing else,
  // which is a different question from /tools': "which of my servers
  // is contributing what", not "where did this tool come from".
  //
  // Explicit attribution (source:'mcp' + server, or a flattened source
  // that is the server's own name) is preferred when present. As of
  // 2026-08 core-agent's production adapter doesn't populate it for
  // MCP tools (pkg/attachadapter/capabilities.go reports source:
  // 'other' pending an upstream metadata pass), so a tool with no
  // usable attribution falls back to the <server>_<tool> naming
  // convention every MCP-namespaced tool still follows. That fallback
  // upgrades itself the moment the backend starts sending real
  // attribution — no client change needed then.
  //
  // `builtin`, `skill:*` and `subagent` are not MCP servers and are
  // excluded rather than guessed at: splitting `fs_read` on its
  // underscore would invent a server called "fs".
  const NON_MCP_SOURCES = ['builtin', 'skill', 'subagent', 'other'];

  function groupToolsByServer(tools) {
    const byServer = new Map();
    (tools || []).forEach((t) => {
      const tool = typeof t === 'string' ? { name: t } : t;
      const name = tool.name;
      if (!name) return;
      const source = toolSource(tool);
      let server = null;
      if (source && NON_MCP_SOURCES.indexOf(toolGroupKey(source)) === -1) {
        server = source;
      } else if (!source || source === 'other') {
        // Unattributed. The convention is the only thing left.
        const idx = name.indexOf('_');
        if (idx <= 0) return;
        server = name.substring(0, idx);
      } else {
        return;
      }
      const bucket = byServer.get(server) || { name: server, status: 'connected', tools: [] };
      // The full name, not stripped of its server prefix — it's the
      // name an operator would actually invoke, and it's how core-tui's
      // /mcp renderer lists it.
      bucket.tools.push({ name, description: tool.description || '' });
      byServer.set(server, bucket);
    });
    return [...byServer.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // The /guardrails report. Plain text rather than a list: it's four
  // fixed rows of state, not a catalog, and a heading per row would be
  // more chrome than content.
  function formatGuardrails(g) {
    const guard = g || {};
    const w = guard.watchdog || {};
    const c = guard.cost_ceiling || {};
    const reason = (r) => (r ? ' (' + r + ')' : '');
    const usd = (n) => '$' + Number(n || 0).toFixed(2);
    return (
      'Guardrails:\n' +
      `  Watchdog:      mode=${w.mode || 'off'} tripped=${!!w.tripped}${reason(w.reason)}\n` +
      `  Cost ceiling:  ${usd(c.session_cost_usd)} / ${usd(c.max_session_usd)} ` +
      `tripped=${!!c.tripped}${reason(c.reason)}\n` +
      `  Halted:        ${!!guard.halted}\n\n` +
      'Usage: /guardrails reset [watchdog|cost_ceiling|all] [additional-budget-usd]'
    );
  }

  // One-line summary of a persisted subagent turn event (the same ADK
  // Event shape the SSE `agent` frame carries), for the `/subagents
  // events` drill-down. Reuses the pure fanoutAgentFrame parser rather
  // than re-deriving Content/parts field-variant handling — the
  // variants are the hard part and there is exactly one correct
  // implementation of them.
  //
  // Here rather than in a shell because two shells now print it. Plain
  // text, not HTML: the caller decides.
  function summarizeAgentEvent(event) {
    if (!window.AttachCoreProtocol) return '(event)';
    const parts = [];
    window.AttachCoreProtocol.fanoutAgentFrame({ event }, (e) => parts.push(e));
    if (parts.length === 0) return '(empty)';
    return parts
      .map((p) => {
        if (p.type === 'stream-chunk') return `text: ${p.data.text.slice(0, 80)}`;
        if (p.type === 'tool-call') return `call ${p.data.name}`;
        if (p.type === 'tool-result') return `result ${p.data.name} (${p.data.latencyMs}ms)`;
        return p.type;
      })
      .join('; ');
  }

  return {
    renderSlashResponse,
    register,
    RENDERERS,
    RESERVED_KEYS,
    SCHEMAS,
    validate,
    escapeHTML,
    renderList,
    renderTools,
    groupToolsBySource,
    groupToolsByServer,
    formatGuardrails,
    summarizeAgentEvent,
  };
})();
