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

// slash-render — dispatch skeleton for rendering server-side slash
// command responses. See docs/v0.2-catch-up-plan.md §"Slash-response
// renderer dispatch" for the design intent — this is the "don't paint
// into a corner" seam so future data-returning commands (a plan tree,
// a search-result table) can slot into a real schema-driven renderer
// without touching a bespoke branch per command.
//
// Response conventions consumed here — reserved in
// attach-core/protocol.js's header + eventual v1.3.0 spec doc note:
//   _render — "text" | "markdown" | "json" | <future>
//   _schema — reserved for v0.3.0+ schema-driven rendering
//
// v0.2.0 built-in renderers: text (pre block), markdown (marked
// pipeline, mirrors how streaming assistant messages render), json
// (pretty-printed). Default when _render is absent: json (safer than
// silently HTML-injecting an unknown shape).
//
// Loaded as a plain <script> in index.html; exposes
// window.SlashRender.

window.SlashRender = (function () {
  'use strict';

  // Registry of renderers keyed by the `_render` value. Add new
  // renderers by extending this map — the dispatcher itself doesn't
  // need to change. Each renderer takes the full response object
  // (minus the `_render` / `_schema` control keys) and returns an
  // HTML string ready to inject into a message container.
  const RENDERERS = {
    text(response) {
      const text = typeof response === 'string' ? response : String(response.body ?? '');
      return '<pre class="slash-render-text">' + escapeHTML(text) + '</pre>';
    },
    markdown(response) {
      const body = typeof response === 'string' ? response : String(response.body ?? '');
      // Uses the same `marked` pipeline the streaming assistant
      // messages render through. Falls back to escaped text when
      // marked isn't available (tests / stripped bundle).
      if (typeof window.marked === 'object' && typeof window.marked.parse === 'function') {
        return window.marked.parse(body);
      }
      return '<pre class="slash-render-text">' + escapeHTML(body) + '</pre>';
    },
    json(response) {
      const stripped = stripReservedKeys(response);
      const pretty = JSON.stringify(stripped, null, 2);
      return '<pre class="slash-render-json">' + escapeHTML(pretty) + '</pre>';
    },
  };

  // Reserved response-body keys that control rendering. Stripped
  // from the display in `json` renderer since they're metadata, not
  // user-visible payload.
  const RESERVED_KEYS = ['_render', '_schema'];

  function stripReservedKeys(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!RESERVED_KEYS.includes(k)) out[k] = v;
    }
    return out;
  }

  function escapeHTML(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Dispatch a slash response to the appropriate renderer.
  //
  // Contract:
  //   - response.type _render controls the renderer choice.
  //   - If _render is absent, defaults to "json".
  //   - If _render names an unknown renderer, logs a console warning
  //     and falls back to "json" (never throws — a spec addition
  //     shouldn't break existing clients).
  //   - Never mutates the input.
  function renderSlashResponse(response) {
    if (response == null) return '<pre class="slash-render-empty">(empty response)</pre>';
    const hint =
      typeof response === 'object' &&
      !Array.isArray(response) &&
      typeof response._render === 'string'
        ? response._render
        : 'json';
    const renderer = RENDERERS[hint];
    if (!renderer) {
      // Unknown _render value — forward-compat behavior is to fall
      // through to json rather than fail so a server that ships a new
      // convention doesn't break older clients.
      console.warn('slash-render: unknown _render value "' + hint + '" — falling back to json');
      return RENDERERS.json(response);
    }
    return renderer(response);
  }

  return {
    renderSlashResponse,
    RENDERERS,
    RESERVED_KEYS,
  };
})();
