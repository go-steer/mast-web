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

// mast-web // spatial shell — a 3D workspace of live mast terminals,
// built from CSS perspective transforms rather than WebGL.
//
// Why not Three.js / react-three-fiber: the panels here are the real
// product surface (transcript markdown, tool-call disclosure, a working
// prompt line, [COPY] / [RETRY] buttons). Getting live DOM onto a WebGL
// quad means rendering it to a texture, and no browser API does that
// for arbitrary DOM — html2canvas re-implements layout and drops most
// of it, SVG foreignObject snapshots aren't live. The usual escape
// hatch is Xterm.js, which owns its own <canvas>; mast-web's transcript
// is not a character grid, so that door is closed. CSS 3D keeps every
// panel as ordinary DOM — selectable, focusable, typable,
// screen-reader-visible — at any camera angle, with no bundler in a
// repo that has deliberately never had one.
//
// The trade is real: no volumetric bloom, no depth-of-field, no
// shadows. Those are faked with layered box-shadows and a vignette,
// which reads convincingly at these panel counts.
//
// Each panel hosts a MastTerminal instance (terminal.js) with its own
// AttachClient, so N sessions stream side by side. The sidebar lists
// every session on every attached daemon; clicking one opens or
// re-centers its terminal.

(function () {
  'use strict';

  const world = document.getElementById('scene-world');
  const viewport = document.getElementById('scene-viewport');
  const floor = document.getElementById('grid-floor');
  const hudPanels = document.getElementById('hud-panels');
  const hudCamera = document.getElementById('hud-camera');
  const statusFocus = document.getElementById('status-focus');
  const statusClock = document.getElementById('status-clock');
  const daemonList = document.getElementById('daemon-list');
  const sidebar = document.getElementById('spatial-sidebar');

  // ─── Camera ───────────────────────────────────────────────────────
  // Orbit is applied to the world, not to a camera object: rotateY is
  // the turntable, rotateX the tilt, translateZ the dolly. Pitch is
  // clamped hard because past ~30° the floor plane edge-ons and the
  // illusion collapses.

  const HOME = { yaw: 0, pitch: 4, dolly: 0 };
  const cam = Object.assign({}, HOME);

  // Must match #scene-viewport's `perspective`. The eye sits this far
  // in front of the world origin, which is what makes a panel's facing
  // angle computable rather than guessable. EYE_Y tracks
  // perspective-origin's 44% — the vanishing point is above centre, so
  // the eye is too.
  const PERSPECTIVE = 1250;
  const EYE_Y = -50;

  // Angle a panel at (x, y, z) has to hold to look straight at the eye.
  // Deriving this instead of authoring it per slot is what turns a
  // scatter of tilted windows into a cockpit: every panel sits on a
  // cylinder around the viewer, so none of them is ever edge-on. Pitch
  // is damped — full vertical facing over-rotates the near slots into
  // something that reads as a dropped card.
  function facingFor(pos) {
    const depth = Math.max(PERSPECTIVE - pos.z, 240);
    const deg = 180 / Math.PI;
    return {
      ry: -Math.atan2(pos.x, depth) * deg,
      rx: Math.atan2(pos.y - EYE_Y, depth) * deg * 0.7,
    };
  }

  // Panel placements are authored against a 1440×860 stage. Rather
  // than reflow them per breakpoint, the whole world scales to fit —
  // the layout is a composition, and a composition should shrink, not
  // rearrange.
  function fitScale() {
    const s = Math.min(window.innerWidth / 1440, window.innerHeight / 860);
    return clamp(s, 0.5, 1.25);
  }

  // ─── Parallax ─────────────────────────────────────────────────────
  // A few degrees of camera lean tracking the pointer. It is the
  // cheapest thing in this file and the one that does the most work: a
  // 3D scene that never answers the mouse reads as a picture of a room,
  // and one that leans a little reads as a room. Kept small and heavily
  // damped — this is peripheral, not a control.

  const PARALLAX_YAW = 3.2;
  const PARALLAX_PITCH = 1.8;
  const parallax = { yaw: 0, pitch: 0 };
  const parallaxAim = { yaw: 0, pitch: 0 };
  const stillness = window.matchMedia('(prefers-reduced-motion: reduce)');
  let parallaxFrame = 0;

  function aimParallax(e) {
    // Dragging a panel or spinning the turntable is a deliberate camera
    // act; parallax must not fight it.
    if (drag || orbit || stillness.matches) return;
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = (e.clientY / window.innerHeight) * 2 - 1;
    // Halved while reading a centered transcript — the lean is there
    // for the room, and the room is not what you're looking at.
    const damp = active ? 0.45 : 1;
    parallaxAim.yaw = nx * PARALLAX_YAW * damp;
    parallaxAim.pitch = -ny * PARALLAX_PITCH * damp;
    if (!parallaxFrame) parallaxFrame = window.requestAnimationFrame(stepParallax);
  }

  function stepParallax() {
    parallaxFrame = 0;
    const dy = parallaxAim.yaw - parallax.yaw;
    const dp = parallaxAim.pitch - parallax.pitch;
    if (Math.abs(dy) < 0.008 && Math.abs(dp) < 0.008) {
      parallax.yaw = parallaxAim.yaw;
      parallax.pitch = parallaxAim.pitch;
      applyCamera();
      return;
    }
    // Exponential ease. Low coefficient = the room has mass.
    parallax.yaw += dy * 0.075;
    parallax.pitch += dp * 0.075;
    applyCamera();
    parallaxFrame = window.requestAnimationFrame(stepParallax);
  }

  function applyCamera() {
    const yaw = cam.yaw + parallax.yaw;
    const pitch = clamp(cam.pitch + parallax.pitch, -22, 34);
    world.style.setProperty('--cam-yaw', yaw.toFixed(2) + 'deg');
    world.style.setProperty('--cam-pitch', pitch.toFixed(2) + 'deg');
    world.style.setProperty('--cam-dolly', cam.dolly.toFixed(0) + 'px');
    world.style.setProperty('--cam-scale', fitScale().toFixed(3));
    // The HUD reports where *you* put the camera, not where the lean
    // happens to be this frame — otherwise the readout never settles.
    hudCamera.textContent = 'yaw ' + Math.round(cam.yaw) + '° pitch ' + Math.round(cam.pitch) + '°';
  }

  // Camera limits live here so nudging, orbiting and restoring a saved
  // view all agree on what a legal camera is.
  const YAW_LIMIT = 55;
  const PITCH_MIN = -18;
  const PITCH_MAX = 30;
  const DOLLY_MIN = -700;
  const DOLLY_MAX = 520;

  function nudgeCamera(dYaw, dPitch, dDolly) {
    cam.yaw = clamp(cam.yaw + dYaw, -YAW_LIMIT, YAW_LIMIT);
    cam.pitch = clamp(cam.pitch + dPitch, PITCH_MIN, PITCH_MAX);
    cam.dolly = clamp(cam.dolly + dDolly, DOLLY_MIN, DOLLY_MAX);
    applyCamera();
    saveWorkspace();
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // ─── Panels ───────────────────────────────────────────────────────

  const panels = new Map();
  let active = null;

  // Parking slots for newly-opened terminals: the four corners first,
  // then the two depth slots down the middle. Corners lead so that the
  // common case — a handful of sessions — leaves the stage centre
  // clear for whichever terminal is active, and nothing sits directly
  // behind anything else. Past the last slot, placement wraps back and
  // to the side. Each x is chosen so the panel's magnified footprint
  // clears the sidebar on the left and the window edge on the right:
  // on-screen half-width is fitScale × 1250/(1250 − z) × PANEL_W/2, so
  // the further forward a slot sits, the closer in its x has to be.
  //
  // Only position is authored; facing comes from facingFor().
  const SLOTS = [
    { x: -450, y: -190, z: -260 },
    { x: 450, y: -190, z: -260 },
    { x: -360, y: 190, z: 30 },
    { x: 330, y: 190, z: 30 },
    { x: -10, y: -230, z: -520 },
    { x: 0, y: 235, z: -430 },
  ];

  // Panel colours come from dedicated slots rather than the status
  // palette. --green/--yellow/--red have ~25 semantic consumers in
  // styles.css (success text, error text, connection dots), so borrowing
  // them meant a theme could not recolour terminals without recolouring
  // every "connected" dot in the sidebar too.
  const HUES = ['--hue-1', '--hue-2', '--hue-3', '--hue-4'];

  const PANEL_W = 440;
  const PANEL_H = 320;

  let spawnCount = 0;

  function slotFor(index) {
    const base = SLOTS[index % SLOTS.length];
    const wrap = Math.floor(index / SLOTS.length);
    // Slots are authored against the *visible* stage, so the whole
    // arrangement slides right by half the sidebar when it's open.
    const inset = stageInset() / 2 / fitScale();
    // Later wraps step back and to the side rather than overlapping.
    const pos = {
      x: base.x + inset + wrap * 46,
      y: base.y + wrap * 34,
      z: base.z - wrap * 180,
    };
    return Object.assign(pos, facingFor(pos));
  }

  function place(p) {
    const el = p.el;
    el.style.setProperty('--tx', Math.round(p.pos.x) + 'px');
    el.style.setProperty('--ty', Math.round(p.pos.y) + 'px');
    el.style.setProperty('--tz', Math.round(p.pos.z) + 'px');
    el.style.setProperty('--ry', p.pos.ry.toFixed(1) + 'deg');
    el.style.setProperty('--rx', p.pos.rx.toFixed(1) + 'deg');
    placeCast(p);
  }

  // ─── Floor casts ──────────────────────────────────────────────────
  // Each panel spills a pool of its own neon onto the grid below it.
  // There is no lighting model here — it's a radial gradient lying flat
  // on the floor plane at the panel's x/z — but faked bounce is what
  // makes the panels read as objects standing in a room rather than
  // images pasted on a backdrop. The pool also brightens while that
  // session is streaming, so fleet activity is legible from the floor
  // alone, peripherally, without reading a single transcript.
  //
  // Casts live in their own layer rather than inside .panel-anchor:
  // nested, they would inherit the panel's facing rotation and lift off
  // the floor.

  const castLayer = document.createElement('div');
  castLayer.id = 'panel-casts';
  castLayer.setAttribute('aria-hidden', 'true');
  world.appendChild(castLayer);

  // Keep in step with #grid-floor's translateY in spatial.css.
  const FLOOR_Y = 420;

  function makeCast(p) {
    const cast = document.createElement('div');
    cast.className = 'panel-cast';
    cast.style.setProperty('--hue', 'var(' + HUES[p.index % HUES.length] + ')');
    castLayer.appendChild(cast);
    return cast;
  }

  function placeCast(p) {
    if (!p.cast) return;
    p.cast.style.setProperty('--cx', Math.round(p.pos.x) + 'px');
    p.cast.style.setProperty('--cz', Math.round(p.pos.z) + 'px');
    // A panel hovering well above the floor throws a wider, fainter
    // pool than one sitting close to it — the one bit of real light
    // behaviour worth imitating.
    const drop = clamp((FLOOR_Y - p.pos.y) / 520, 0.6, 1.6);
    p.cast.style.setProperty('--cspread', drop.toFixed(2));
  }

  function updateCast(p) {
    if (!p.cast) return;
    p.cast.classList.toggle('cast-busy', !!p.term.state.running);
    p.cast.classList.toggle('cast-active', active === p);
    p.cast.dataset.conn = p.term.state.connState;
  }

  // ─── Focus model ──────────────────────────────────────────────────
  // One terminal at a time is "active": it squares up to the camera at
  // the stage centre, grows to reading size, stops drifting, and takes
  // the keyboard. Everything else recesses so its neon doesn't compete
  // with the transcript you just asked to read. Clicking any panel
  // hands it the active slot; Escape sends it back to its parking spot.

  // The centred panel sits forward of the origin, and #scene-viewport's
  // perspective magnifies anything it pulls toward the camera. A CSS
  // box authored at N px therefore lands on screen at N × this factor —
  // size it in raw pixels and it overflows the window. Everything below
  // is authored in on-screen pixels and divided back through.
  const CENTER_Z = 250;

  function centerMagnification() {
    return fitScale() * (PERSPECTIVE / (PERSPECTIVE - CENTER_Z));
  }

  function stageInset() {
    return document.body.classList.contains('side-hidden') ? 0 : sidebar.offsetWidth;
  }

  function centeredPos() {
    // Shift right by half the sidebar so the enlarged panel is centred
    // in the *visible* stage rather than under the agent list.
    const shift = stageInset() / 2 / centerMagnification();
    return { x: shift, y: 4 / centerMagnification(), z: CENTER_Z, ry: 0, rx: 0 };
  }

  function centeredSize() {
    // Stop well short of the edges: the room behind the terminal — and
    // specifically the other terminals parked in it — is what makes
    // this a workspace rather than a full-screen page. Wide enough to
    // read comfortably, narrow enough that the corner slots still show
    // past it.
    const m = centerMagnification();
    const availW = (window.innerWidth - stageInset() - 96) * 0.72;
    const availH = (window.innerHeight - 128) * 0.88;
    return {
      w: clamp(availW / m, 380, 900),
      h: clamp(availH / m, 280, 660),
    };
  }

  function activate(p) {
    if (active === p) return;
    if (active) park(active);
    active = p;
    if (!p) {
      document.body.classList.remove('has-active');
      statusFocus.textContent = 'active: —';
      updateSidebar();
      saveWorkspace();
      return;
    }
    p.el.classList.add('active');
    p.parked = Object.assign({}, p.pos);
    p.pos = centeredPos();
    resizeActive();
    place(p);
    updateCast(p);
    document.body.classList.add('has-active');
    statusFocus.textContent = 'active: ' + p.title;
    // The size change animates; pin the transcript to the bottom once
    // it has settled, and hand over the keyboard.
    window.setTimeout(function () {
      p.term.reflow();
      p.term.focusInput();
    }, 460);
    updateSidebar();
    saveWorkspace();
  }

  function park(p) {
    p.el.classList.remove('active');
    if (p.parked) p.pos = Object.assign({}, p.parked);
    p.panel.style.setProperty('--pw', PANEL_W + 'px');
    p.panel.style.setProperty('--ph', PANEL_H + 'px');
    if (active === p) {
      active = null;
      document.body.classList.remove('has-active');
      statusFocus.textContent = 'active: —';
    }
    place(p);
    updateCast(p);
    saveWorkspace();
  }

  function toggleActive(p) {
    if (active === p) {
      park(p);
      updateSidebar();
    } else {
      activate(p);
    }
  }

  // ─── Terminal panels ──────────────────────────────────────────────

  function panelKey(endpoint, sessionId) {
    return endpoint + '#' + sessionId;
  }

  // opts.focus === false opens the panel straight into its parking
  // slot instead of taking the centre — that's what lets "open all"
  // fill the room without every terminal fighting for the camera.
  // opts.index and opts.pos are the restore path: they pin the hue and
  // the resting spot a reloaded panel had before, instead of handing it
  // the next free slot.
  function openTerminal(daemon, session, opts) {
    const focus = !opts || opts.focus !== false;
    const key = panelKey(daemon.endpoint, session.id);
    const existing = panels.get(key);
    if (existing) {
      if (focus) activate(existing);
      return existing;
    }

    const index = opts && Number.isInteger(opts.index) ? opts.index : spawnCount;
    spawnCount = Math.max(spawnCount, index + 1);

    const anchor = document.createElement('div');
    anchor.className = 'panel-anchor';
    anchor.dataset.panel = key;

    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.dataset.kind = 'term';
    panel.style.setProperty('--hue', 'var(' + HUES[index % HUES.length] + ')');
    panel.style.setProperty('--pw', PANEL_W + 'px');
    panel.style.setProperty('--ph', PANEL_H + 'px');
    // Negative delay desynchronises the drift so the panels never
    // breathe in lockstep, which instantly reads as fake.
    panel.style.setProperty('--drift-delay', (index * -3.7).toFixed(1) + 's');

    const title = (session.app ? session.app + ' // ' : '') + session.id;

    const bar = document.createElement('header');
    bar.className = 'panel-bar';
    const titleEl = document.createElement('span');
    titleEl.className = 'panel-title';
    titleEl.textContent = title;
    titleEl.title = daemon.alias + ' · ' + session.id;
    bar.appendChild(titleEl);

    const controls = document.createElement('span');
    controls.className = 'panel-controls';
    controls.appendChild(ctlButton('□', 'Center or park ' + title));
    controls.appendChild(ctlButton('×', 'Close ' + title));
    bar.appendChild(controls);

    const body = document.createElement('div');
    body.className = 'panel-body';

    panel.appendChild(bar);
    panel.appendChild(body);
    anchor.appendChild(panel);
    world.appendChild(anchor);

    // Declared up here, not at the assignment below: MastTerminal.create
    // calls onChange synchronously while it builds (it seeds the status
    // line with 'disconnected'), so a `const p` further down would still
    // be in its temporal dead zone when the callback first runs.
    let p = null;

    const term = window.MastTerminal.create({
      endpoint: daemon.endpoint,
      token: daemon.token,
      sessionId: session.id,
      label: title,
      onChange: function (t, what) {
        if (what === 'conn') panel.dataset.conn = t.state.connState;
        if (what === 'busy') panel.classList.toggle('panel-busy', t.state.running);
        if (p) updateCast(p);
      },
    });
    body.appendChild(term.el);

    p = {
      key: key,
      index: index,
      title: title,
      daemon: daemon,
      session: session,
      el: anchor,
      panel: panel,
      body: body,
      term: term,
      pos: slotFor(index),
      home: slotFor(index),
      parked: null,
      cast: null,
    };
    if (opts && opts.pos) {
      // Restored: drop it back where it was, re-deriving the facing
      // rather than trusting a saved angle, so a viewport resize since
      // the last visit still produces a panel aimed at the camera.
      p.pos = Object.assign({ x: opts.pos.x, y: opts.pos.y, z: opts.pos.z }, facingFor(opts.pos));
      p.parked = Object.assign({}, p.pos);
    }
    p.cast = makeCast(p);
    place(p);
    updateCast(p);
    panels.set(key, p);
    updateCount();

    const buttons = controls.querySelectorAll('.panel-ctl');
    buttons[0].addEventListener('click', function (e) {
      e.stopPropagation();
      toggleActive(p);
    });
    buttons[1].addEventListener('click', function (e) {
      e.stopPropagation();
      closePanel(p);
    });

    // Click-to-activate, distinguished from drag-to-move by distance:
    // a press that travels less than a few pixels was a click, and a
    // click anywhere on a terminal means "this is the one I'm using".
    // Resolved in endPointer rather than here — a title-bar press takes
    // pointer capture on the viewport, so the matching pointerup never
    // reaches the anchor.
    anchor.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      press = { panel: p, x: e.clientX, y: e.clientY, ctl: !!e.target.closest('.panel-ctl') };
    });

    bar.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.panel-ctl')) return;
      startPanelDrag(p, e);
    });

    term.connect().catch(function () {
      // connect() already painted the failure into the transcript.
    });

    if (focus) activate(p);
    updateSidebar();
    saveWorkspace();
    return p;
  }

  // Open every session the daemon reported, parked, so the operator
  // can see the whole fleet at once. The first one takes the centre
  // only if nothing else already has it.
  function openAll(d) {
    const claim = !active;
    d.sessions.forEach(function (s, i) {
      openTerminal(d, s, { focus: claim && i === 0 });
    });
  }

  function ctlButton(glyph, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'panel-ctl';
    b.textContent = glyph;
    b.title = label;
    b.setAttribute('aria-label', label);
    return b;
  }

  function closePanel(p) {
    p.term.destroy();
    p.el.classList.add('closing');
    if (p.cast) {
      const cast = p.cast;
      p.cast = null;
      cast.classList.add('closing');
      window.setTimeout(function () {
        cast.remove();
      }, 320);
    }
    if (active === p) {
      active = null;
      document.body.classList.remove('has-active');
      statusFocus.textContent = 'active: —';
    }
    panels.delete(p.key);
    updateCount();
    updateSidebar();
    saveWorkspace();
    window.setTimeout(function () {
      p.el.remove();
    }, 320);
  }

  function updateCount() {
    const n = panels.size;
    hudPanels.textContent = n + (n === 1 ? ' terminal' : ' terminals');
  }

  // Re-park everything into fresh slots, in open order.
  function tile() {
    let i = 0;
    panels.forEach(function (p) {
      const slot = slotFor(i);
      i += 1;
      p.home = Object.assign({}, slot);
      p.parked = Object.assign({}, slot);
      if (p !== active) {
        p.pos = Object.assign({}, slot);
        place(p);
      }
    });
    saveWorkspace();
  }

  // ─── Dragging ─────────────────────────────────────────────────────
  // Screen-space drag deltas are rotated back into world space by the
  // camera yaw, so a panel tracks the pointer instead of sliding off
  // sideways once the turntable has been spun. Pitch is ignored — at
  // the clamped tilt the vertical error is a couple of pixels.

  let drag = null;
  let press = null;

  function startPanelDrag(p, e) {
    drag = {
      panel: p,
      startX: e.clientX,
      startY: e.clientY,
      origin: Object.assign({}, p.pos),
    };
    p.el.classList.add('dragging');
    viewport.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  let orbit = null;

  function startOrbit(e) {
    orbit = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch };
    document.body.classList.add('dragging-camera');
    viewport.setPointerCapture(e.pointerId);
  }

  viewport.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    // Anything that isn't a panel is background: orbit the turntable.
    if (!e.target.closest('.panel')) startOrbit(e);
  });

  viewport.addEventListener('pointermove', function (e) {
    if (drag) {
      // Undo the fit-scale so a 100px pointer move is a 100px world
      // move on a laptop as well as a monitor. Perspective
      // foreshortening at depth is left uncorrected — far panels track
      // slightly fast, which reads as intentional inertia.
      const s = fitScale();
      const dx = (e.clientX - drag.startX) / s;
      const dy = (e.clientY - drag.startY) / s;
      const yaw = (cam.yaw * Math.PI) / 180;
      const p = drag.panel;
      p.pos.x = drag.origin.x + dx * Math.cos(yaw);
      p.pos.z = drag.origin.z + dx * Math.sin(yaw);
      p.pos.y = drag.origin.y + dy;
      // Re-face as it moves: a panel dragged across the room turns to
      // keep looking at you, the way it would on a real curved rig.
      // The active panel stays square — it's being read.
      if (p !== active) Object.assign(p.pos, facingFor(p.pos));
      place(p);
      return;
    }
    if (orbit) {
      cam.yaw = clamp(orbit.yaw + (e.clientX - orbit.x) * 0.13, -YAW_LIMIT, YAW_LIMIT);
      cam.pitch = clamp(orbit.pitch - (e.clientY - orbit.y) * 0.08, PITCH_MIN, PITCH_MAX);
      applyCamera();
    }
  });

  function endPointer(e) {
    if (drag) {
      // A dragged panel keeps its new spot: if it was the active one,
      // that becomes the centre it snaps back to next time.
      const p = drag.panel;
      p.el.classList.remove('dragging');
      if (p !== active) p.parked = Object.assign({}, p.pos);
      drag = null;
      saveWorkspace();
    }
    if (orbit) {
      orbit = null;
      document.body.classList.remove('dragging-camera');
      saveWorkspace();
    }
    if (press) {
      const hit = press;
      press = null;
      // A control button owns its own click; a travelled press was a
      // drag. Anything else is "make this the terminal I'm using".
      if (e.type !== 'pointerup' || hit.ctl) return;
      const moved = Math.hypot(e.clientX - hit.x, e.clientY - hit.y);
      if (moved <= 5 && panels.has(hit.panel.key) && active !== hit.panel) activate(hit.panel);
    }
  }

  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);

  // On window, not the viewport: the lean should keep tracking while
  // the pointer is over the sidebar or the HUD.
  window.addEventListener('pointermove', aimParallax);

  viewport.addEventListener(
    'wheel',
    function (e) {
      // Scrolling a transcript is not a dolly.
      if (e.target.closest('.panel-body')) return;
      e.preventDefault();
      nudgeCamera(0, 0, -e.deltaY * 0.6);
    },
    { passive: false }
  );

  document.addEventListener('keydown', function (e) {
    // Escape works from inside a prompt — it's the way back out of a
    // centered terminal. Every other binding yields to the text field.
    if (e.key === 'Escape') {
      if (active) {
        park(active);
        updateSidebar();
        viewport.focus({ preventScroll: true });
        e.preventDefault();
      }
      return;
    }
    if (e.target.closest('input, textarea')) return;
    switch (e.key) {
      case 'ArrowLeft':
        nudgeCamera(-4, 0, 0);
        break;
      case 'ArrowRight':
        nudgeCamera(4, 0, 0);
        break;
      case 'ArrowUp':
        nudgeCamera(0, 2, 0);
        break;
      case 'ArrowDown':
        nudgeCamera(0, -2, 0);
        break;
      case '+':
      case '=':
        nudgeCamera(0, 0, 60);
        break;
      case '-':
        nudgeCamera(0, 0, -60);
        break;
      case 'r':
      case 'R':
      case '0':
        resetView();
        break;
      case 'a':
      case 'A':
        daemons.forEach(openAll);
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  function resetView() {
    Object.assign(cam, HOME);
    applyCamera();
    if (active) park(active);
    tile();
    updateSidebar();
  }

  // ─── Workspace persistence ────────────────────────────────────────
  // A refresh used to land you in an empty room: the daemon list came
  // back but every open terminal was gone. The layout is the thing the
  // operator arranged by hand, so it is worth keeping — which sessions
  // were open, where each one rests, which one had the camera, and
  // where the camera was. Panel *contents* are not saved; each restored
  // terminal reconnects and replays its own event log, which is the
  // authoritative transcript anyway.

  const WORKSPACE_KEY = 'mast-web:spatial-workspace';
  const saved = readWorkspace();
  let restoring = false;
  let saveTimer = 0;

  // Endpoints whose saved panels have not been restored yet. A daemon
  // that hasn't answered yet looks exactly like a daemon whose sessions
  // are gone, and guessing wrong is expensive: concluding "gone" throws
  // the layout away, and the next save makes that permanent. So rows
  // stay armed here until the daemon actually reports a session list —
  // they survive every write in the meantime, and each refresh gets
  // another go at them.
  const pending = new Set();
  if (saved) {
    saved.panels.forEach(function (r) {
      pending.add(r.endpoint);
    });
  }

  function rowKey(r) {
    return r.endpoint + '#' + r.id;
  }

  function readWorkspace() {
    try {
      const raw = localStorage.getItem(WORKSPACE_KEY);
      const w = raw ? JSON.parse(raw) : null;
      if (w && w.v === 1 && Array.isArray(w.panels)) return w;
    } catch {
      /* corrupt or blocked storage — open an empty room */
    }
    return null;
  }

  // The durable spot is where a panel *rests*, not where it is right
  // now: the active one is temporarily at the stage centre, and its
  // parking slot is what should come back on reload.
  function restingPos(p) {
    return p.parked || p.pos;
  }

  function writeWorkspace() {
    const rows = [];
    panels.forEach(function (p) {
      const at = restingPos(p);
      rows.push({
        endpoint: p.daemon.endpoint,
        id: p.session.id,
        index: p.index,
        x: Math.round(at.x),
        y: Math.round(at.y),
        z: Math.round(at.z),
      });
    });
    // Carry forward anything still waiting on an unreachable daemon, so
    // a save triggered while it is down doesn't erase the layout.
    if (saved && pending.size) {
      const live = new Set(rows.map(rowKey));
      saved.panels.forEach(function (r) {
        if (pending.has(r.endpoint) && !live.has(rowKey(r))) rows.push(r);
      });
    }

    try {
      localStorage.setItem(
        WORKSPACE_KEY,
        JSON.stringify({
          v: 1,
          cam: { yaw: cam.yaw, pitch: cam.pitch, dolly: cam.dolly },
          active: active ? active.key : pending.size && saved ? saved.active : null,
          panels: rows,
        })
      );
    } catch {
      /* blocked storage — the room is still live in memory */
    }
  }

  // Coalesced: a drag fires this on every pointerup and a restore fires
  // it once per panel, and none of that needs its own storage write.
  function saveWorkspace() {
    if (restoring || saveTimer) return;
    saveTimer = window.setTimeout(function () {
      saveTimer = 0;
      writeWorkspace();
    }, 250);
  }

  function restoreCamera() {
    if (!saved || !saved.cam) return;
    cam.yaw = clamp(Number(saved.cam.yaw) || 0, -YAW_LIMIT, YAW_LIMIT);
    cam.pitch = clamp(Number(saved.cam.pitch) || 0, PITCH_MIN, PITCH_MAX);
    cam.dolly = clamp(Number(saved.cam.dolly) || 0, DOLLY_MIN, DOLLY_MAX);
    applyCamera();
  }

  // Called every time a daemon's session list lands — at boot, on the
  // 30s poll, on ↻, and when one is attached. It is a no-op unless that
  // endpoint still has rows armed, so a re-list never reopens a
  // terminal the operator deliberately closed.
  //
  // A saved session that has genuinely disappeared upstream is dropped
  // rather than opened against a dead id; one whose daemon merely
  // failed to answer is left armed for the next attempt.
  function restoreInto(d) {
    if (!saved || !pending.has(d.endpoint) || d.state !== 'connected') return;
    pending.delete(d.endpoint);

    const mine = saved.panels.filter(function (r) {
      return r.endpoint === d.endpoint;
    });
    if (mine.length === 0) return;

    restoring = true;
    let toFocus = null;
    mine.forEach(function (r) {
      const session = d.sessions.find(function (s) {
        return s.id === r.id;
      });
      if (!session) return;
      const p = openTerminal(d, session, {
        focus: false,
        index: r.index,
        pos: { x: r.x, y: r.y, z: r.z },
      });
      if (p && saved.active === p.key) toFocus = p;
    });
    restoring = false;

    // No save here: a restore reproduces what is already on disk, and
    // writing at this point is what used to flatten the layout when the
    // list came back short.
    if (toFocus) activate(toFocus);
  }

  // ─── Daemons + sessions ───────────────────────────────────────────
  // The registry is the same localStorage contract index.html writes
  // ('mast-web:daemons', with the legacy single-entry 'mast-web:config'
  // as a fallback), so a daemon added in either shell shows up in the
  // other. Each daemon keeps one session-less AttachClient purely for
  // listSessions / createSession; the live SSE clients belong to the
  // terminals.

  const daemons = new Map();

  function aliasFor(endpoint) {
    if (endpoint === '/') return 'same-origin';
    try {
      const u = new URL(endpoint, window.location.href);
      return u.host || endpoint;
    } catch {
      return endpoint;
    }
  }

  function loadDaemons() {
    let rows = [];
    try {
      const raw = localStorage.getItem('mast-web:daemons');
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) rows = arr;
    } catch {
      /* blocked storage — fall through */
    }
    if (rows.length === 0) {
      try {
        const raw = localStorage.getItem('mast-web:config');
        const cfg = raw ? JSON.parse(raw) : null;
        if (cfg && cfg.endpoint) rows = [cfg];
      } catch {
        /* blocked storage — fall through */
      }
    }
    // Nothing stored: the SPA is being served by a backend often enough
    // that same-origin is the right first guess.
    if (rows.length === 0) rows = [{ endpoint: '/', token: '' }];
    return rows;
  }

  function persistDaemons() {
    const rows = [];
    daemons.forEach(function (d) {
      rows.push({ endpoint: d.endpoint, token: d.token || '', alias: d.alias, addedAt: d.addedAt });
    });
    try {
      localStorage.setItem('mast-web:daemons', JSON.stringify(rows));
    } catch {
      /* blocked storage — the registry is still live in memory */
    }
  }

  function addDaemon(endpoint, token) {
    const ep = (endpoint || '').trim().replace(/\/+$/, '') || '/';
    const existing = daemons.get(ep);
    if (existing) return existing;
    const d = {
      endpoint: ep,
      token: token || '',
      alias: aliasFor(ep),
      addedAt: new Date().toISOString(),
      state: 'connecting',
      sessions: [],
      error: '',
      client: new window.AttachClient({ endpoint: ep, token: token || '' }),
    };
    daemons.set(ep, d);
    persistDaemons();
    updateSidebar();
    return d;
  }

  function removeDaemon(d) {
    panels.forEach(function (p) {
      if (p.daemon.endpoint === d.endpoint) closePanel(p);
    });
    daemons.delete(d.endpoint);
    persistDaemons();
    updateSidebar();
  }

  async function refreshDaemon(d) {
    d.state = 'connecting';
    updateSidebar();
    try {
      d.sessions = await d.client.listSessions();
      d.state = 'connected';
      d.error = '';
    } catch (e) {
      d.sessions = [];
      d.state = 'error';
      d.error = e && e.message ? e.message : String(e);
    }
    updateSidebar();
    // Every list is a chance to bring a saved layout back — the boot
    // one usually does it, but if the daemon was down then, the 30s
    // poll or a manual ↻ picks it up instead.
    restoreInto(d);
  }

  function refreshAll() {
    daemons.forEach(function (d) {
      refreshDaemon(d);
    });
  }

  async function newSession(d) {
    try {
      const s = await d.client.createSession();
      await refreshDaemon(d);
      openTerminal(d, { id: s.id, app: s.app, user: s.user, status: 'active' });
    } catch (e) {
      d.error = e && e.message ? e.message : String(e);
      updateSidebar();
    }
  }

  // ─── Sidebar ──────────────────────────────────────────────────────

  function updateSidebar() {
    daemonList.replaceChildren();
    daemons.forEach(function (d) {
      const group = document.createElement('div');
      group.className = 'side-group';

      const head = document.createElement('div');
      head.className = 'side-daemon';
      head.dataset.state = d.state;
      const dot = document.createElement('span');
      dot.className = 'side-dot';
      const name = document.createElement('span');
      name.className = 'side-daemon-name';
      name.textContent = d.alias;
      name.title = d.endpoint;
      head.appendChild(dot);
      head.appendChild(name);

      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'side-icon';
      all.textContent = '⊞';
      all.title = 'Open all ' + d.sessions.length + ' sessions on ' + d.alias + '  (a)';
      all.disabled = d.sessions.length === 0;
      all.addEventListener('click', function () {
        openAll(d);
      });
      head.appendChild(all);

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'side-icon';
      add.textContent = '+';
      add.title = 'New session on ' + d.alias;
      add.addEventListener('click', function () {
        newSession(d);
      });
      head.appendChild(add);

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'side-icon';
      drop.textContent = '×';
      drop.title = 'Detach ' + d.alias;
      drop.addEventListener('click', function () {
        removeDaemon(d);
      });
      head.appendChild(drop);
      group.appendChild(head);

      if (d.state === 'error') {
        const err = document.createElement('div');
        err.className = 'side-error';
        err.textContent = d.error || 'unreachable';
        group.appendChild(err);
      } else if (d.sessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'side-empty';
        empty.textContent = d.state === 'connecting' ? 'listing…' : 'no sessions';
        group.appendChild(empty);
      }

      d.sessions.forEach(function (s) {
        const key = panelKey(d.endpoint, s.id);
        const p = panels.get(key);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'side-session';
        if (p) row.classList.add('open');
        if (p && p === active) row.classList.add('active');
        row.dataset.status = s.status || 'active';

        const idEl = document.createElement('span');
        idEl.className = 'side-session-id';
        idEl.textContent = s.id;
        const metaEl = document.createElement('span');
        metaEl.className = 'side-session-meta';
        metaEl.textContent = s.app || s.user || '';
        row.appendChild(idEl);
        row.appendChild(metaEl);
        row.title = s.id + (s.app ? ' · ' + s.app : '') + ' · ' + d.endpoint;

        row.addEventListener('click', function () {
          openTerminal(d, s);
        });
        group.appendChild(row);
      });

      daemonList.appendChild(group);
    });
  }

  // ─── Wiring ───────────────────────────────────────────────────────

  document.getElementById('btn-tile').addEventListener('click', function () {
    if (active) park(active);
    tile();
    updateSidebar();
  });
  document.getElementById('btn-reset').addEventListener('click', resetView);
  document.getElementById('btn-refresh').addEventListener('click', refreshAll);
  document.getElementById('btn-sidebar').addEventListener('click', function () {
    const before = stageInset();
    document.body.classList.toggle('side-hidden');
    // The visible stage just changed width. Slide the arrangement to
    // match rather than re-tiling — a panel the operator dragged
    // somewhere deliberate should stay where they put it, relative to
    // the room.
    const shift = (stageInset() - before) / 2 / fitScale();
    panels.forEach(function (p) {
      if (p.parked) p.parked.x += shift;
      p.home.x += shift;
      if (p !== active) {
        p.pos.x += shift;
        place(p);
      }
    });
    if (active) {
      active.pos = centeredPos();
      resizeActive();
      place(active);
    }
  });

  function resizeActive() {
    if (!active) return;
    const size = centeredSize();
    active.panel.style.setProperty('--pw', Math.round(size.w) + 'px');
    active.panel.style.setProperty('--ph', Math.round(size.h) + 'px');
  }

  document.getElementById('add-daemon').addEventListener('submit', function (e) {
    e.preventDefault();
    const epEl = document.getElementById('add-endpoint');
    const tokEl = document.getElementById('add-token');
    const d = addDaemon(epEl.value, tokEl.value);
    tokEl.value = '';
    refreshDaemon(d);
  });

  window.setInterval(function () {
    statusClock.textContent = new Date().toLocaleTimeString('en-GB');
  }, 1000);

  window.addEventListener('resize', function () {
    applyCamera();
    if (active) {
      resizeActive();
      active.pos = centeredPos();
      place(active);
    }
  });

  // The floor is the largest orbit target; give it a cursor hint.
  floor.style.cursor = 'grab';

  // ─── Theme ────────────────────────────────────────────────────────
  // The room now follows the theme all the way — backdrop, panel
  // surfaces, shadows and cast strength all come from the --room-* /
  // --panel-* knobs in styles.css, so a light theme gets a light room
  // instead of light windows floating in a black void.
  //
  // The list is duplicated from app.js's THEMES rather than shared:
  // index.html is frozen, so a common themes.js has no way to reach the
  // classic shell. Both shells read and write the same storage key, so
  // picking here is the same as /theme there.

  const THEMES = [
    { id: 'default', label: 'Go brand' },
    { id: 'grayscale-dark', label: 'Google grayscale · dark' },
    { id: 'grayscale-light', label: 'Google grayscale · light' },
    { id: 'solarized-dark', label: 'Solarized dark' },
    { id: 'solarized-light', label: 'Solarized light' },
    { id: 'high-contrast', label: 'High contrast' },
    { id: 'mono', label: 'Monochrome' },
    { id: 'paper', label: 'Paper' },
  ];

  function applyTheme(id) {
    if (id && id !== 'default') document.body.setAttribute('data-theme', id);
    else document.body.removeAttribute('data-theme');
    try {
      localStorage.setItem('mast-web:theme', id);
    } catch {
      /* blocked storage — the choice still holds for this visit */
    }
  }

  const themeSelect = document.getElementById('hud-theme');
  let startTheme = 'default';
  try {
    startTheme = localStorage.getItem('mast-web:theme') || 'default';
  } catch {
    /* private mode — Go brand it is */
  }
  THEMES.forEach(function (t) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    themeSelect.appendChild(opt);
  });
  themeSelect.value = THEMES.some(function (t) {
    return t.id === startTheme;
  })
    ? startTheme
    : 'default';
  applyTheme(themeSelect.value);
  themeSelect.addEventListener('change', function () {
    applyTheme(themeSelect.value);
  });

  // A refresh can land inside the 250ms coalescing window, which would
  // lose the last drag or focus change. pagehide fires for reloads,
  // navigations and tab close alike, and unlike unload it survives
  // bfcache — so flush there.
  window.addEventListener('pagehide', function () {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
    }
    writeWorkspace();
  });

  // The room is a fixed-size viewport, never a scrolling document, so
  // there is no scroll position worth restoring — and restoring one is
  // actively harmful: an offset picked up once (a focus, a tab through
  // the HUD) would be reinstated by every subsequent refresh, leaving
  // the HUD scrolled off the top. Where the camera was looking is the
  // real "scroll position" here, and restoreCamera() handles that.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  restoreCamera();
  applyCamera();
  updateCount();
  const registered = new Set();
  loadDaemons().forEach(function (row) {
    registered.add(row.endpoint);
    // Panels come back from inside refreshDaemon, as soon as this
    // daemon reports which sessions still exist.
    refreshDaemon(addDaemon(row.endpoint, row.token));
  });

  // Rows for a daemon that is no longer attached have nothing left to
  // wait for; disarm them so they stop being carried forward.
  pending.forEach(function (endpoint) {
    if (!registered.has(endpoint)) pending.delete(endpoint);
  });

  // ─── Public seam ──────────────────────────────────────────────────
  window.MastSpatial = {
    panels: panels,
    daemons: daemons,
    open: openTerminal,
    openAll: openAll,
    activate: activate,
    camera: cam,
    resetView: resetView,
    refreshAll: refreshAll,
  };
})();
