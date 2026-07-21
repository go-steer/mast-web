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

// Unit tests for web/state/connection.js — the connection state
// machine + client/prompter/turn refs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcSubs = readFileSync(join(here, 'subscriptions.js'), 'utf8');
const srcConn = readFileSync(join(here, 'connection.js'), 'utf8');

function loadConnectionStore() {
  new Function('window', srcSubs)(globalThis);
  new Function('window', srcConn)(globalThis);
  return globalThis.MastState.connection;
}

describe('state/connection', () => {
  let conn;
  beforeEach(() => {
    delete globalThis.MastState;
    conn = loadConnectionStore();
    conn.store.reset();
  });

  it('initial state', () => {
    const s = conn.store.get();
    expect(s.state).toBe('disconnected');
    expect(s.client).toBeNull();
    expect(s.prompter).toBeNull();
    expect(s.isRunning).toBe(false);
    expect(s.activeTurn).toBeNull();
  });

  it('setState transitions through the state machine', () => {
    conn.setState('connecting');
    expect(conn.store.get().state).toBe('connecting');
    conn.setState('connected');
    expect(conn.isConnected()).toBe(true);
    conn.setState('terminal');
    expect(conn.store.get().state).toBe('terminal');
    expect(conn.isConnected()).toBe(false);
  });

  it('setClient / getClient roundtrip', () => {
    const fakeClient = { id: 'x' };
    conn.setClient(fakeClient);
    expect(conn.getClient()).toBe(fakeClient);
  });

  it('setPrompter / getPrompter roundtrip', () => {
    const fakePrompter = { id: 'p' };
    conn.setPrompter(fakePrompter);
    expect(conn.getPrompter()).toBe(fakePrompter);
  });

  it('setIsRunning coerces to boolean + isRunning reflects', () => {
    conn.setIsRunning(1);
    expect(conn.isRunning()).toBe(true);
    conn.setIsRunning(0);
    expect(conn.isRunning()).toBe(false);
  });

  it('setActiveTurn / getActiveTurn roundtrip', () => {
    const turn = { finish: () => {} };
    conn.setActiveTurn(turn);
    expect(conn.getActiveTurn()).toBe(turn);
    conn.setActiveTurn(null);
    expect(conn.getActiveTurn()).toBeNull();
  });
});
