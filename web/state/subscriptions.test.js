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

// Unit tests for web/state/subscriptions.js — the tiny createStore
// primitive. Verifies the contract documented in the module header:
// get / set / subscribe / reset semantics, patch merging behavior,
// unsubscribe, and listener isolation on throws.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'subscriptions.js'), 'utf8');

function loadSubs() {
  new Function('window', src)(globalThis);
  return globalThis.MastState.subscriptions;
}

describe('state/subscriptions', () => {
  let createStore;
  beforeEach(() => {
    delete globalThis.MastState;
    createStore = loadSubs().createStore;
  });

  it('get returns the current value', () => {
    const s = createStore({ n: 1 });
    expect(s.get()).toEqual({ n: 1 });
  });

  it('set with object patch shallow-merges into current object state', () => {
    const s = createStore({ a: 1, b: 2 });
    s.set({ b: 20, c: 30 });
    expect(s.get()).toEqual({ a: 1, b: 20, c: 30 });
  });

  it('set with function replaces via the returned value', () => {
    const s = createStore({ n: 1 });
    s.set((cur) => ({ ...cur, n: cur.n + 1 }));
    expect(s.get()).toEqual({ n: 2 });
  });

  it('set with a non-object patch replaces the value entirely', () => {
    // Primitive state — patch replaces rather than merging.
    const s = createStore(1);
    s.set(2);
    expect(s.get()).toBe(2);
  });

  it('set on non-object state ignores object-patch merge behavior', () => {
    // If the current state isn't an object, an object patch replaces
    // it (can't merge into a scalar).
    const s = createStore(null);
    s.set({ x: 1 });
    expect(s.get()).toEqual({ x: 1 });
  });

  it('subscribe fires on set and receives the new value', () => {
    const s = createStore({ n: 0 });
    const fn = vi.fn();
    s.subscribe(fn);
    s.set({ n: 1 });
    expect(fn).toHaveBeenCalledWith({ n: 1 });
  });

  it('subscribe returns an unsubscribe function', () => {
    const s = createStore({ n: 0 });
    const fn = vi.fn();
    const unsub = s.subscribe(fn);
    s.set({ n: 1 });
    unsub();
    s.set({ n: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers fire in insertion order', () => {
    const s = createStore({ n: 0 });
    const calls = [];
    s.subscribe(() => calls.push('a'));
    s.subscribe(() => calls.push('b'));
    s.subscribe(() => calls.push('c'));
    s.set({ n: 1 });
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('one subscriber throwing does not break the others (or the store)', () => {
    const s = createStore({ n: 0 });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good1 = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good2 = vi.fn();
    s.subscribe(good1);
    s.subscribe(bad);
    s.subscribe(good2);
    s.set({ n: 1 });
    expect(good1).toHaveBeenCalled();
    expect(bad).toHaveBeenCalled();
    expect(good2).toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('reset restores the initial value + fires subscribers', () => {
    const s = createStore({ n: 0 });
    s.set({ n: 1 });
    const fn = vi.fn();
    s.subscribe(fn);
    s.reset();
    expect(s.get()).toEqual({ n: 0 });
    expect(fn).toHaveBeenCalledWith({ n: 0 });
  });

  it('function-form set on primitive state returns the new primitive', () => {
    const s = createStore(1);
    s.set((cur) => cur * 3);
    expect(s.get()).toBe(3);
  });
});
